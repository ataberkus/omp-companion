// The screen helper's C# source, compiled by Windows PowerShell for each viewer (see screen.mjs).

// Screen sharing (Windows): one helper process per viewer, Windows PowerShell compiling this C# with Add-Type (no install,
// no npm dependency). It captures one monitor (with the cursor), scales it to the viewer's width, and writes only the changed
// rectangle as a JPEG, one per frame credit the companion grants, so a slow link gets fewer frames instead of a growing queue.
// stdout: [u32 LE length][type][payload]; type 1 = u16 LE x,y,w,h,frameWidth,frameHeight + JPEG, type 2 = JSON text.
// stdin: one command per line (see screenCommands); EOF releases every key and button it holds down, then exits.
export const SCREEN_HELPER=String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class OmpScreenHelper {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int size, flags; public IntPtr cursor; public POINT pos; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool icon; public int hotX, hotY; public IntPtr mask, color; }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);

  static readonly object gate = new object();
  static Stream output;
  static int credits, monitor = -1, primary, maxWidth = 1280, quality = 60;
  static bool full = true, quit;
  static Rectangle[] screens;
  static readonly HashSet<int> keysDown = new HashSet<int>();
  static readonly bool[] buttonsDown = new bool[3];
  static readonly uint[] buttonFlags = { 2, 0x20, 8 };

  public static void Run() {
    // Physical pixels on scaled displays, for capture bounds, cursor position and input coordinates alike.
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
    output = Console.OpenStandardOutput();
    LoadScreens();
    new Thread(ReadCommands) { IsBackground = true }.Start();
    CaptureLoop();
  }

  static void LoadScreens() {
    var all = Screen.AllScreens;
    lock (gate) {
      screens = new Rectangle[all.Length];
      for (int i = 0; i < all.Length; i++) { screens[i] = all[i].Bounds; if (all[i].Primary) primary = i; }
      if (monitor < 0 || monitor >= screens.Length) monitor = primary;
    }
  }

  static void EmitMonitors() {
    var list = new StringBuilder("{\"t\":\"monitors\",\"list\":[");
    lock (gate) {
      for (int i = 0; i < screens.Length; i++) list.AppendFormat("{0}{{\"w\":{1},\"h\":{2},\"primary\":{3}}}", i > 0 ? "," : "", screens[i].Width, screens[i].Height, i == primary ? "true" : "false");
      list.AppendFormat("],\"current\":{0}}}", monitor);
    }
    Emit(2, null, Encoding.UTF8.GetBytes(list.ToString()));
  }

  static void Emit(byte type, byte[] head, byte[] body) { Emit(type, head, body, body.Length); }
  static void Emit(byte type, byte[] head, byte[] body, int length) {
    int total = 1 + (head == null ? 0 : head.Length) + length;
    lock (output) {
      output.Write(BitConverter.GetBytes(total), 0, 4);
      output.WriteByte(type);
      if (head != null) output.Write(head, 0, head.Length);
      output.Write(body, 0, length);
      output.Flush();
    }
  }

  static void Status(string text) {
    Emit(2, null, Encoding.UTF8.GetBytes("{\"t\":\"status\",\"text\":\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ") + "\"}"));
  }

  static void CaptureLoop() {
    Bitmap raw = null, scaled = null; int[] prev = null, cur = null; string lastError = null;
    var jpeg = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.FormatID == ImageFormat.Jpeg.Guid);
    var timer = Stopwatch.StartNew(); long lastFrame = -1000; int idle = 0;
    while (true) {
      Rectangle b; int mw, q; bool reset;
      lock (gate) {
        while (credits <= 0 && !quit) Monitor.Wait(gate);
        if (quit) return;
        b = screens[monitor]; mw = maxWidth; q = quality; reset = full; full = false;
      }
      // At most ~30 frames a second; an unchanged screen is checked less often the longer it stays still.
      long wait = Math.Max(33 - (timer.ElapsedMilliseconds - lastFrame), idle);
      if (wait > 0) Thread.Sleep((int)wait);
      int sw = Math.Min(b.Width, mw), sh = Math.Max(1, (int)Math.Round((double)b.Height * sw / b.Width));
      if (raw == null || raw.Width != b.Width || raw.Height != b.Height) { if (scaled != null && scaled != raw) scaled.Dispose(); if (raw != null) raw.Dispose(); raw = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppRgb); scaled = null; reset = true; }
      if (sw == b.Width) { if (scaled != null && scaled != raw) scaled.Dispose(); scaled = raw; }
      else if (scaled == null || scaled == raw || scaled.Width != sw || scaled.Height != sh) { if (scaled != null && scaled != raw) scaled.Dispose(); scaled = new Bitmap(sw, sh, PixelFormat.Format32bppRgb); reset = true; }
      try {
        using (var g = Graphics.FromImage(raw)) { g.CopyFromScreen(b.X, b.Y, 0, 0, b.Size, CopyPixelOperation.SourceCopy); DrawCursor(g, b); }
        if (lastError != null) Status("");
        lastError = null;
      } catch (Exception e) {
        if (lastError != e.Message) Status("This PC's screen can't be captured right now (" + e.Message + "). Windows hides the sign-in screen and administrator prompts from other apps.");
        lastError = e.Message; lock (gate) full = true; Thread.Sleep(500); continue;
      }
      if (scaled != raw) using (var g = Graphics.FromImage(scaled)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.PixelOffsetMode = PixelOffsetMode.HighSpeed; g.CompositingQuality = CompositingQuality.HighSpeed; g.DrawImage(raw, new Rectangle(0, 0, sw, sh)); }
      int n = sw * sh;
      if (cur == null || cur.Length != n) { cur = new int[n]; prev = new int[n]; reset = true; }
      var data = scaled.LockBits(new Rectangle(0, 0, sw, sh), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
      try { for (int y = 0; y < sh; y++) Marshal.Copy(data.Scan0 + y * data.Stride, cur, y * sw, sw); } finally { scaled.UnlockBits(data); }
      int x0 = 0, y0 = 0, x1 = sw, y1 = sh;
      if (!reset) {
        x0 = sw; y0 = sh; x1 = 0; y1 = 0;
        for (int y = 0; y < sh; y++) {
          int row = y * sw, l = 0, r = sw - 1;
          while (l < sw && cur[row + l] == prev[row + l]) l++;
          if (l == sw) continue;
          while (cur[row + r] == prev[row + r]) r--;
          if (y < y0) y0 = y;
          y1 = y + 1;
          if (l < x0) x0 = l;
          if (r + 1 > x1) x1 = r + 1;
        }
        if (x1 == 0) { idle = Math.Min(100, idle + 10); continue; }
        // JPEG works in 16-pixel blocks: aligned patches leave no seams next to unchanged areas.
        x0 &= ~15; y0 &= ~15; x1 = Math.Min(sw, (x1 + 15) & ~15); y1 = Math.Min(sh, (y1 + 15) & ~15);
      }
      idle = 0;
      var swap = prev; prev = cur; cur = swap;
      var rect = new Rectangle(x0, y0, x1 - x0, y1 - y0);
      var ms = new MemoryStream();
      using (var part = scaled.Clone(rect, PixelFormat.Format24bppRgb)) {
        var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)q);
        part.Save(ms, jpeg, ps);
      }
      var head = new byte[12];
      ushort[] fields = { (ushort)x0, (ushort)y0, (ushort)rect.Width, (ushort)rect.Height, (ushort)sw, (ushort)sh };
      for (int i = 0; i < 6; i++) BitConverter.GetBytes(fields[i]).CopyTo(head, i * 2);
      lock (gate) credits--;
      Emit(1, head, ms.GetBuffer(), (int)ms.Length);
      lastFrame = timer.ElapsedMilliseconds;
    }
  }

  static void DrawCursor(Graphics g, Rectangle b) {
    var ci = new CURSORINFO(); ci.size = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0) return;
    ICONINFO ii; if (!GetIconInfo(ci.cursor, out ii)) return;
    if (ii.mask != IntPtr.Zero) DeleteObject(ii.mask);
    if (ii.color != IntPtr.Zero) DeleteObject(ii.color);
    int x = ci.pos.x - b.X - ii.hotX, y = ci.pos.y - b.Y - ii.hotY;
    if (x >= b.Width || y >= b.Height || x < -128 || y < -128) return;
    IntPtr hdc = g.GetHdc();
    try { DrawIconEx(hdc, x, y, ci.cursor, 0, 0, 0, IntPtr.Zero, 3); } finally { g.ReleaseHdc(hdc); }
  }

  static void Send(INPUT input) { SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))); }
  static void Mouse(uint flags, uint data, int dx, int dy) {
    var i = new INPUT(); i.type = 0; i.u.mi.flags = flags; i.u.mi.data = data; i.u.mi.dx = dx; i.u.mi.dy = dy; Send(i);
  }
  static void Key(int vk, bool ext, bool down) {
    var i = new INPUT(); i.type = 1; i.u.ki.vk = (ushort)vk; i.u.ki.scan = (ushort)MapVirtualKey((uint)vk, 0);
    i.u.ki.flags = (ext ? 1u : 0u) | (down ? 0u : 2u); Send(i);
    lock (keysDown) { if (down) keysDown.Add(vk | (ext ? 0x10000 : 0)); else keysDown.Remove(vk | (ext ? 0x10000 : 0)); }
  }
  static void Unicode(ushort c) {
    var i = new INPUT(); i.type = 1; i.u.ki.scan = c; i.u.ki.flags = 4; Send(i);
    i.u.ki.flags = 6; Send(i);
  }

  // x and y are 0..65535 across the shared monitor; SendInput wants 0..65535 across the whole virtual desktop.
  static void MoveTo(int nx, int ny) {
    Rectangle b; lock (gate) b = screens[monitor];
    int px = b.X + (int)Math.Round((double)nx * (b.Width - 1) / 65535), py = b.Y + (int)Math.Round((double)ny * (b.Height - 1) / 65535);
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = Math.Max(2, GetSystemMetrics(78)), vh = Math.Max(2, GetSystemMetrics(79));
    Mouse(0x8001 | 0x4000, 0, (int)Math.Round((px - vx) * 65535.0 / (vw - 1)), (int)Math.Round((py - vy) * 65535.0 / (vh - 1)));
  }

  static void ReleaseAll() {
    for (int i = 0; i < 3; i++) if (buttonsDown[i]) { buttonsDown[i] = false; Mouse(buttonFlags[i] << 1, 0, 0, 0); }
    int[] keys; lock (keysDown) { keys = new int[keysDown.Count]; keysDown.CopyTo(keys); }
    foreach (var k in keys) Key(k & 0xffff, (k & 0x10000) != 0, false);
  }

  static void ReadCommands() {
    var input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
    string line;
    while ((line = input.ReadLine()) != null && line != "q") {
      var a = line.Split(' ');
      try {
        switch (a[0]) {
          case "m": MoveTo(int.Parse(a[1]), int.Parse(a[2])); break;
          case "b": { int i = int.Parse(a[1]); bool down = a[2] == "1"; if (buttonsDown[i] == down) break; buttonsDown[i] = down; Mouse(down ? buttonFlags[i] : buttonFlags[i] << 1, 0, 0, 0); break; }
          case "w": { int dy = int.Parse(a[1]), dx = int.Parse(a[2]); if (dy != 0) Mouse(0x800, unchecked((uint)dy), 0, 0); if (dx != 0) Mouse(0x1000, unchecked((uint)dx), 0, 0); break; }
          case "k": Key(int.Parse(a[1]), a[2] == "1", a[3] == "1"); break;
          case "t": for (int i = 1; i < a.Length; i++) Unicode(Convert.ToUInt16(a[i], 16)); break;
          case "x": ReleaseAll(); break;
          case "f": lock (gate) { credits = Math.Min(4, credits + int.Parse(a[1])); Monitor.PulseAll(gate); } break;
          case "r": lock (gate) { full = true; Monitor.PulseAll(gate); } break;
          case "c":
            LoadScreens();
            lock (gate) { int m = int.Parse(a[1]); monitor = m < 0 || m >= screens.Length ? primary : m; maxWidth = int.Parse(a[2]); quality = int.Parse(a[3]); full = true; Monitor.PulseAll(gate); }
            EmitMonitors(); break;
        }
      } catch (Exception e) { Status("Screen helper: " + e.Message); }
    }
    ReleaseAll();
    lock (gate) { quit = true; Monitor.PulseAll(gate); }
  }
}
`;
