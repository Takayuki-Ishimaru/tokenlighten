import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../assets/licenses/onnxruntime/", import.meta.url));
const provenance = JSON.parse(readFileSync(join(root, "PROVENANCE.json"), "utf8"));

/** npm omits these legal files; redistribute the exact reviewed upstream originals. */
export function onnxRuntimeLegalFiles(packageId) {
  if (!packageId.startsWith("onnxruntime-")) return undefined;
  const record = provenance.revisions.find(item => item.packages.includes(packageId));
  if (!record) throw new Error(`ONNX Runtime legal provenance must be reviewed for ${packageId}`);
  const names = packageId.startsWith("onnxruntime-common@") ? ["LICENSE"] : ["LICENSE", "ThirdPartyNotices.txt"];
  return names.map(name => {
    const source = record.files.find(file => file.upstreamPath === name);
    if (!source || source.url !== `https://raw.githubusercontent.com/microsoft/onnxruntime/${record.sha}/${name}`) throw new Error(`Invalid ONNX Runtime legal provenance for ${packageId}`);
    const bytes = readFileSync(join(root, name));
    if (bytes.length !== source.bytes || createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error(`ONNX Runtime legal resource changed: ${name}`);
    return { name, bytes, source: source.url };
  });
}

export function copyOnnxRuntimeLegalFiles(packageId, destination) {
  const files = onnxRuntimeLegalFiles(packageId);
  for (const file of files ?? []) writeFileSync(join(destination, file.name), file.bytes);
  if (files) writeFileSync(join(destination, "TOKENLIGHTEN_LEGAL_PROVENANCE.json"), `${JSON.stringify({ package: packageId,
    note: provenance.note, files: files.map(file => ({ name: file.name, source: file.source, sha256: createHash("sha256").update(file.bytes).digest("hex") })) }, null, 2)}\n`);
}
