# Initiative 1: Flexible Terraform CLI Installer Download

## Goal

Allow the Terraform installer task to download from three sources:

1. **HashiCorp official releases** — current behavior, remains the default
2. **terraform-registry-backend** — version lookup AND download URL from a private registry API, with SHA256 integrity verification
3. **Simple mirror URL** — for JFrog Artifactory, Nexus, Azure Blob, or any server that mirrors the HashiCorp releases directory structure

## Files to Modify

| File | Change |
| --- | --- |
| `Tasks/TerraformInstaller/TerraformInstallerV1/task.json` | Add `downloadSource`, `registryUrl`, `registryMirrorName`, `mirrorBaseUrl` inputs |
| `Tasks/TerraformInstaller/TerraformInstallerV1/task.loc.json` | Add localization keys |
| `Tasks/TerraformInstaller/TerraformInstallerV1/Strings/resources.resjson/en-US/resources.resjson` | Add localized strings |
| `Tasks/TerraformInstaller/TerraformInstallerV1/src/terraform-installer.ts` | Refactor into strategy functions |
| `Tasks/TerraformInstaller/TerraformInstallerV1/Tests/` | Add new test pairs |

## Versioning

Increment TerraformInstallerV1 task `Minor` version (e.g., `0.0.x` → `0.1.0`). Do not create V2 — V1 remains the active installer task version.

## Background: terraform-registry-backend API

The `terraform-registry-backend` project exposes a Terraform CLI binary API under `/terraform/binaries`. All endpoints are **unauthenticated** (public by design).

**Relevant endpoints:**

```text
GET /terraform/binaries/{name}/versions/latest
  Returns latest synced version metadata including version number

GET /terraform/binaries/{name}/versions/{version}/{os}/{arch}
  Returns JSON with pre-signed download URL (15-minute TTL) and SHA256 checksum
```

`{name}` is the mirror configuration name in the registry (e.g., `"terraform"` or `"opentofu"`).

**Download response shape:**

```json
{
  "os": "linux",
  "arch": "amd64",
  "version": "1.9.0",
  "filename": "terraform_1.9.0_linux_amd64.zip",
  "sha256": "abc123...",
  "download_url": "https://storage-backend/signed-url?expires=..."
}
```

**Latest version response shape (abridged):**

```json
{
  "id": "uuid",
  "version": "1.9.0",
  "is_latest": true,
  "platforms": [{ "os": "linux", "arch": "amd64" }]
}
```

Source file references in `terraform-registry-backend`:

- Handler: `backend/internal/api/terraform_binaries/binaries.go`
- Routes: `backend/internal/api/router.go` lines 344–351
- Models: `backend/internal/db/models/terraform_mirror.go`

## New Task Inputs (task.json)

```json
{
  "name": "downloadSource",
  "type": "pickList",
  "label": "Download source",
  "defaultValue": "hashicorp",
  "required": true,
  "helpMarkDown": "Where to download the Terraform binary from.",
  "options": {
    "hashicorp": "HashiCorp official releases (releases.hashicorp.com)",
    "registry": "Private registry (terraform-registry-backend)",
    "mirror": "Custom mirror URL"
  }
},
{
  "name": "registryUrl",
  "type": "string",
  "label": "Registry base URL",
  "visibleRule": "downloadSource = registry",
  "required": true,
  "helpMarkDown": "Base URL of your terraform-registry-backend instance. Example: https://registry.example.com"
},
{
  "name": "registryMirrorName",
  "type": "string",
  "label": "Mirror configuration name",
  "visibleRule": "downloadSource = registry",
  "required": true,
  "defaultValue": "terraform",
  "helpMarkDown": "The mirror configuration name in your registry. This is the {name} segment in /terraform/binaries/{name}/..."
},
{
  "name": "mirrorBaseUrl",
  "type": "string",
  "label": "Mirror base URL",
  "visibleRule": "downloadSource = mirror",
  "required": true,
  "helpMarkDown": "Base URL of your binary mirror. Must serve files at the same path structure as releases.hashicorp.com/terraform. Example: https://artifacts.example.com/hashicorp/terraform"
}
```

**Security constraint:** All URL inputs are validated to require HTTPS. Plain HTTP is rejected with a task failure.

## Logic Changes to `terraform-installer.ts`

Refactor `downloadTerraform()` into a strategy pattern with three download functions.

### `downloadFromHashiCorp(version, proxy)` — existing logic, extracted

- Latest version: checkpoint API → fallback `1.14.6`
- URL: `https://releases.hashicorp.com/terraform/{version}/terraform_{version}_{os}_{arch}.zip`

### `downloadFromRegistry(version, registryUrl, mirrorName, proxy)` — new

```typescript
async function downloadFromRegistry(
    version: string,
    registryUrl: string,
    mirrorName: string,
    proxy: any
): Promise<{ zipPath: string; resolvedVersion: string }> {
    // Step 1: Resolve 'latest' if needed
    if (version.toLowerCase() === 'latest') {
        const latestUrl = `${registryUrl}/terraform/binaries/${mirrorName}/versions/latest`;
        const latestData = await fetchJson(latestUrl, proxy);
        version = latestData.version;
        console.log(`Resolved latest version from registry: ${version}`);
    }

    // Step 2: Get platform-specific download URL + SHA256
    const osPlatform = getPlatformString();   // linux / darwin / windows
    const arch = getArchString();             // amd64 / arm64 / 386 / arm
    const infoUrl =
        `${registryUrl}/terraform/binaries/${mirrorName}/versions/${version}/${osPlatform}/${arch}`;
    const data = await fetchJson(infoUrl, proxy);
    // data.download_url = pre-signed storage URL
    // data.sha256       = hex SHA256 of the zip

    // Step 3: Download from pre-signed URL using existing tool-lib helper
    const fileName = `terraform-${version}-${uuidV4()}.zip`;
    const zipPath = await tools.downloadTool(data.download_url, fileName);

    // Step 4: Verify SHA256 integrity
    await verifySha256(zipPath, data.sha256);

    return { zipPath, resolvedVersion: version };
}
```

### `downloadFromMirror(version, mirrorBaseUrl, proxy)` — new

- Latest version: still uses HashiCorp checkpoint API (mirrors serve binaries but not version discovery)
- URL: `{mirrorBaseUrl}/{version}/terraform_{version}_{os}_{arch}.zip`
- No SHA256 verification (mirrors don't provide checksums via this path)

### Main `downloadTerraform()` function

```typescript
export async function downloadTerraform(inputVersion: string): Promise<string> {
    const downloadSource = tasks.getInput("downloadSource") || "hashicorp";
    let zipPath: string;
    let resolvedVersion: string = inputVersion;

    switch (downloadSource) {
        case "registry": {
            const result = await downloadFromRegistry(
                inputVersion,
                tasks.getInput("registryUrl", true),
                tasks.getInput("registryMirrorName", true),
                proxy
            );
            zipPath = result.zipPath;
            resolvedVersion = result.resolvedVersion;
            tasks.setVariable('terraformDownloadedFrom',
                `registry:${tasks.getInput("registryUrl", true)}`);
            break;
        }
        case "mirror": {
            zipPath = await downloadFromMirror(
                inputVersion,
                tasks.getInput("mirrorBaseUrl", true),
                proxy
            );
            tasks.setVariable('terraformDownloadedFrom',
                `mirror:${tasks.getInput("mirrorBaseUrl", true)}`);
            break;
        }
        default: { // "hashicorp"
            zipPath = await downloadFromHashiCorp(inputVersion, proxy);
            tasks.setVariable('terraformDownloadedFrom', 'hashicorp');
        }
    }

    // Shared: extract, cache, set executable permission, set output variable
    const version = tools.cleanVersion(resolvedVersion);
    const unzippedPath = await tools.extractZip(zipPath);
    const cachedPath = await tools.cacheDir(unzippedPath, "terraform", version);
    const terraformPath = findTerraformExecutable(cachedPath);
    if (!isWindows) { fs.chmodSync(terraformPath, "777"); }
    tasks.setVariable('terraformLocation', terraformPath);
    return terraformPath;
}
```

### New helper: `verifySha256(filePath, expectedHash)`

Uses Node.js `crypto` module to compute SHA256 of the downloaded zip and compare against the registry-provided hash. Throws if mismatch.

```typescript
async function verifySha256(filePath: string, expectedHash: string): Promise<void> {
    const crypto = require('crypto');
    const fileBuffer = fs.readFileSync(filePath);
    const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new Error(
            `SHA256 verification failed. Expected: ${expectedHash}, Got: ${actualHash}`
        );
    }
    tasks.debug(`SHA256 verification passed: ${actualHash}`);
}
```

### New helper: `fetchJson(url, proxy)`

Extracted reusable function wrapping `node-fetch` + proxy logic. Returns parsed JSON or throws on HTTP error.

```typescript
async function fetchJson(url: string, proxy: any): Promise<any> {
    if (!url.startsWith('https://')) {
        throw new Error(`Insecure URL rejected: ${url}. Only HTTPS is allowed.`);
    }
    const options: any = {};
    if (proxy != null) {
        const proxyUrl = proxy.proxyUsername != ""
            ? proxy.proxyUrl.split("://")[0] + '://' + proxy.proxyUsername + ':'
              + proxy.proxyPassword + '@' + proxy.proxyUrl.split("://")[1]
            : proxy.proxyUrl;
        options.agent = new HttpsProxyAgent(proxyUrl);
    }
    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return response.json();
}
```

## New Output Variable

- `terraformDownloadedFrom` — logs the source (`hashicorp`, `registry:{url}`, or `mirror:{url}`) for diagnostics and audit.

## New Tests

Follow existing `TerraformInstallerV1` test pattern (mock-runner `.ts` + L0 `.ts` pairs):

| Test file | Scenario |
| --- | --- |
| `RegistryLatestSuccess` | `downloadSource=registry`, `version=latest` → resolves from registry, downloads pre-signed URL |
| `RegistrySpecificVersionSuccess` | `downloadSource=registry`, specific version |
| `RegistryUnavailable_Fail` | Registry returns 503 |
| `MirrorCustomUrlSuccess` | `downloadSource=mirror`, downloads from custom base URL |
| `MirrorHttpNotHttps_Fail` | Rejects HTTP mirror URL |
| `HashicorpLatest_Success` | Existing behavior preserved (regression test) |
| `RegistrySha256Mismatch_Fail` | SHA256 verification catches tampered binary |
