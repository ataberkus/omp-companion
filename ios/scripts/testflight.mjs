// Gets App Store Connect ready for a TestFlight upload of OMP Control (ios/), run by .github/workflows/ios-testflight.yml
// after the distribution certificate is in the keychain:
//   - registers the App ID dev.omp.companion if it is missing;
//   - checks the App Store Connect app exists (Apple's API cannot create one: App Store Connect → Apps → "+");
//   - keeps an App Store provisioning profile "OMP Control App Store" for the App ID and the certificate whose serial
//     is CERT_SERIAL (recreated when it is invalid or for another certificate), written to PROFILE_OUT;
//   - prints the build number: one above the highest App Store Connect has for VERSION, among its builds and its
//     uploads still in flight (1 for a version without any). Run one at a time.
// Prints KEY=value lines for $GITHUB_ENV: BUILD_NUMBER, PROFILE_NAME, PROFILE_UUID.
//   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8="$(cat AuthKey.p8)" CERT_SERIAL=… PROFILE_OUT=… VERSION=1.0.0 node ios/scripts/testflight.mjs
import crypto from "node:crypto";
import fs from "node:fs";

const BUNDLE_ID = "dev.omp.companion";
const APP_NAME = "OMP Control";
const PROFILE_NAME = "OMP Control App Store";

const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8, CERT_SERIAL, PROFILE_OUT, VERSION } = process.env;
if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_P8) throw new Error("ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 are required");
if (!CERT_SERIAL || !PROFILE_OUT) throw new Error("CERT_SERIAL and PROFILE_OUT are required");
if (!/^\d+\.\d+\.\d+$/.test(VERSION ?? "")) throw new Error(`VERSION ${VERSION} is not x.y.z`);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" })}.${b64({ iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" })}`;
const signature = crypto.sign("sha256", Buffer.from(unsigned), { key: ASC_KEY_P8, dsaEncoding: "ieee-p1363" }).toString("base64url");
const token = `${unsigned}.${signature}`;

async function api(method, url, body) {
  const res = await fetch(url.startsWith("https:") ? url : `https://api.appstoreconnect.apple.com${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`App Store Connect ${method} ${url.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 500)}`);
  return res.status === 204 ? null : res.json();
}
const get = (url) => api("GET", url);
const log = (...a) => console.error(...a);

// App ID.
let bundle = (await get(`/v1/bundleIds?filter[identifier]=${BUNDLE_ID}&filter[platform]=IOS`)).data.find(
  (b) => b.attributes.identifier === BUNDLE_ID,
);
if (!bundle) {
  log(`Registering the App ID ${BUNDLE_ID}`);
  bundle = (
    await api("POST", "/v1/bundleIds", {
      data: { type: "bundleIds", attributes: { identifier: BUNDLE_ID, name: APP_NAME, platform: "IOS" } },
    })
  ).data;
}

// App Store Connect app.
const app = (await get(`/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=bundleId,name`)).data.find(
  (a) => a.attributes.bundleId === BUNDLE_ID,
);
if (!app) {
  throw new Error(
    `No App Store Connect app for ${BUNDLE_ID} yet. Create it once: appstoreconnect.apple.com → Apps → "+" → New App ` +
      `(iOS, name ${APP_NAME}, bundle ID ${BUNDLE_ID}, SKU e.g. omp-control-ios), then run this again.`,
  );
}

// Distribution certificate, by the serial of the one in the keychain. Its name holds the team's: not logged.
const serial = CERT_SERIAL.replace(/^serial=/i, "").replace(/^0+/, "").toUpperCase();
const certs = (await get(`/v1/certificates?limit=200&fields[certificates]=serialNumber,certificateType,name,expirationDate`)).data;
const cert = certs.find((c) => c.attributes.serialNumber.replace(/^0+/, "").toUpperCase() === serial);
if (!cert) throw new Error(`No certificate with serial ${serial} in the team: IOS_DIST_CERT_P12 is not this team's`);

// Provisioning profile.
const profiles = await get(`/v1/profiles?filter[name]=${encodeURIComponent(PROFILE_NAME)}&include=bundleId,certificates&limit=50`);
let profile = null;
for (const p of profiles.data) {
  const ok =
    p.attributes.name === PROFILE_NAME &&
    p.attributes.profileType === "IOS_APP_STORE" &&
    p.attributes.profileState === "ACTIVE" &&
    p.relationships.bundleId.data?.id === bundle.id &&
    p.relationships.certificates.data?.some((c) => c.id === cert.id);
  if (ok && !profile) profile = p;
  else if (p.attributes.name === PROFILE_NAME) {
    log(`Deleting the outdated profile ${p.id}`);
    await api("DELETE", `/v1/profiles/${p.id}`);
  }
}
if (!profile) {
  log(`Creating the profile "${PROFILE_NAME}"`);
  profile = (
    await api("POST", "/v1/profiles", {
      data: {
        type: "profiles",
        attributes: { name: PROFILE_NAME, profileType: "IOS_APP_STORE" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundle.id } },
          certificates: { data: [{ type: "certificates", id: cert.id }] },
        },
      },
    })
  ).data;
}
fs.writeFileSync(PROFILE_OUT, Buffer.from(profile.attributes.profileContent, "base64"));

// Build number.
async function highestOf(url, key) {
  let highest = 0;
  while (url) {
    const page = await get(url);
    for (const record of page.data) highest = Math.max(highest, Number.parseInt(record.attributes[key], 10) || 0);
    url = page.links?.next;
  }
  return highest;
}
const highest = Math.max(
  await highestOf(`/v1/builds?filter[app]=${app.id}&filter[preReleaseVersion.version]=${VERSION}&fields[builds]=version&limit=200`, "version"),
  await highestOf(`/v1/apps/${app.id}/buildUploads?filter[cfBundleShortVersionString]=${VERSION}&fields[buildUploads]=cfBundleVersion&limit=200`, "cfBundleVersion"),
);

console.log(`BUILD_NUMBER=${highest + 1}`);
console.log(`PROFILE_NAME=${PROFILE_NAME}`);
console.log(`PROFILE_UUID=${profile.attributes.uuid}`);
