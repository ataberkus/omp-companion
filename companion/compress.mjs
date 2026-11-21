// Response compression shared by the dashboard's files (routes/static.mjs) and the API's JSON (router.mjs).
// Phones reach the companion over plain HTTP on Tailscale or the LAN, where browsers offer only gzip and deflate.
// q=0 refuses a coding (RFC 9110 12.4.2): "gzip;q=0, identity" gets the body raw.
export const acceptsGzip=h=>String(h||'').split(',').some(p=>{const [c,...ps]=p.split(';').map(x=>x.trim().toLowerCase());return (c==='gzip'||c==='x-gzip')&&!ps.some(x=>/^q=0(?:\.0*)?$/.test(x));});
// Vary keeps what CORS already set (Origin) and adds Accept-Encoding, once.
export const varyEncoding=res=>{const v=String(res.getHeader?.('Vary')||'');return /\baccept-encoding\b/i.test(v)?v:[v,'Accept-Encoding'].filter(Boolean).join(', ');};
// If-None-Match holds one tag or a list ("a", "b"), weak ones (W/"a") compared weakly (RFC 9110 13.1.2); * matches any.
export const tagMatches=(header,tag)=>{const h=String(header||'').trim();if(!h)return false;if(h==='*')return true;return h.split(',').some(t=>t.trim().replace(/^W\//,'')===tag);};
