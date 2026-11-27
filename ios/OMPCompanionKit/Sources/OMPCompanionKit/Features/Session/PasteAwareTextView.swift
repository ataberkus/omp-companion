import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A clipboard item the composer attaches instead of pasting as text.
enum ClipboardAttachment {
    case pdf(Data)
    case image(UIImage)

    /// Metadata-only check: does not read pasteboard contents, so it never triggers the paste-permission prompt.
    static var generalPasteboardHasAttachment: Bool {
        let board = UIPasteboard.general
        return board.contains(pasteboardTypes: [UTType.pdf.identifier]) || board.hasImages
    }

    /// A PDF wins over an image (PDF viewers also put a rendered page image on the clipboard).
    static func fromGeneralPasteboard() -> ClipboardAttachment? {
        let board = UIPasteboard.general
        if let data = board.data(forPasteboardType: UTType.pdf.identifier) {
            return .pdf(data)
        }
        if let image = board.image {
            return .image(image)
        }
        return nil
    }
}

/// Multi-line composer field that grows from 1 to `maxLines` lines, then scrolls.
/// Unlike SwiftUI `TextField`, a pasted image or PDF (edit menu "Paste", ⌘V, or the keyboard's
/// paste suggestion) reaches `onPasteAttachment` instead of being dropped; text pastes as usual.
struct PasteAwareTextField: View {
    let placeholder: String
    @Binding var text: String
    @Binding var isFocused: Bool
    var maxLines: Int = 6
    let onPasteAttachment: (ClipboardAttachment) -> Void

    var body: some View {
        PasteAwareTextViewRepresentable(
            text: $text,
            isFocused: $isFocused,
            placeholder: placeholder,
            maxLines: maxLines,
            onPasteAttachment: onPasteAttachment
        )
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder)
                    .font(.body)
                    .foregroundStyle(Color(uiColor: .placeholderText))
                    .lineLimit(1)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }
}

private struct PasteAwareTextViewRepresentable: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    let placeholder: String
    let maxLines: Int
    let onPasteAttachment: (ClipboardAttachment) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> PasteAwareUITextView {
        let view = PasteAwareUITextView()
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        // Always scrolling, sized by `sizeThatFits`: switching a UITextView between scrolling and non-scrolling layout
        // right after its text was replaced (Enhance's Replace Draft takes a one-line draft past `maxLines` at once)
        // left TextKit showing the previous text while `text` held the new one.
        view.isScrollEnabled = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.text = text
        let coordinator = context.coordinator
        view.onPasteAttachment = { [weak coordinator] attachment in
            coordinator?.parent.onPasteAttachment(attachment)
        }
        return view
    }

    func updateUIView(_ view: PasteAwareUITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text {
            view.text = text
        }
        let palette = context.environment.ompPalette
        view.textColor = UIColor(palette.foreground)
        view.tintColor = UIColor(palette.accent)
        view.accessibilityLabel = placeholder

        let enabled = context.environment.isEnabled
        view.isUserInteractionEnabled = enabled
        let wantsFocus = isFocused && enabled
        if wantsFocus != view.isFirstResponder {
            // First-responder changes fire delegate callbacks that write the focus binding;
            // defer them out of the SwiftUI update pass.
            DispatchQueue.main.async { [weak view, coordinator = context.coordinator] in
                guard let view else { return }
                let stillWants = coordinator.parent.isFocused && view.isUserInteractionEnabled
                if stillWants, !view.isFirstResponder, view.window != nil {
                    view.becomeFirstResponder()
                } else if !stillWants, view.isFirstResponder {
                    view.resignFirstResponder()
                }
            }
        }
    }

    /// Measures only: SwiftUI calls this several times per layout with different proposals, so it must not change the
    /// view (the text view keeps scrolling on; the height caps at `maxLines`).
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: PasteAwareUITextView, context: Context) -> CGSize? {
        let proposed = proposal.width ?? uiView.bounds.width
        let finiteWidth = proposed.isFinite && proposed > 0 ? proposed : nil
        let fitting = uiView.sizeThatFits(CGSize(width: finiteWidth ?? .greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        let lineHeight = (uiView.font ?? .preferredFont(forTextStyle: .body)).lineHeight
        let minHeight = ceil(lineHeight)
        let maxHeight = ceil(lineHeight * CGFloat(maxLines))
        let height = min(max(ceil(fitting.height), minHeight), maxHeight)
        return CGSize(width: finiteWidth ?? fitting.width, height: height)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: PasteAwareTextViewRepresentable

        init(parent: PasteAwareTextViewRepresentable) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            if parent.text != textView.text {
                parent.text = textView.text
            }
            textView.scrollRangeToVisible(textView.selectedRange)
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.isFocused {
                parent.isFocused = true
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.isFocused {
                parent.isFocused = false
            }
        }
    }
}

final class PasteAwareUITextView: UITextView {
    var onPasteAttachment: ((ClipboardAttachment) -> Void)?

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        // Advertising image/PDF types lets the edit menu and the keyboard's paste suggestion
        // offer "Paste" for a clipboard that holds no text.
        pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [
            UTType.pdf.identifier,
            UTType.image.identifier,
            UTType.text.identifier,
        ])
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), isEditable, ClipboardAttachment.generalPasteboardHasAttachment {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        // User-initiated paste: reading the pasteboard here does not prompt.
        if let attachment = ClipboardAttachment.fromGeneralPasteboard() {
            onPasteAttachment?(attachment)
            return
        }
        super.paste(sender)
    }

    override func paste(itemProviders: [NSItemProvider]) {
        if let provider = itemProviders.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) }) {
            provider.loadDataRepresentation(forTypeIdentifier: UTType.pdf.identifier) { [weak self] data, _ in
                guard let data else { return }
                DispatchQueue.main.async { self?.onPasteAttachment?(.pdf(data)) }
            }
            return
        }
        if let provider = itemProviders.first(where: { $0.canLoadObject(ofClass: UIImage.self) }) {
            provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
                guard let image = object as? UIImage else { return }
                DispatchQueue.main.async { self?.onPasteAttachment?(.image(image)) }
            }
            return
        }
        super.paste(itemProviders: itemProviders)
    }
}
