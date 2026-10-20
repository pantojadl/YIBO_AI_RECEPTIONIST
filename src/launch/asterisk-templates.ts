import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ASTERISK_TEMPLATE_FILES = [
  "pjsip.conf",
  "extensions.conf",
  "ari.conf",
  "http.conf",
  "rtp.conf",
  "modules.conf",
] as const;

export function validateAsteriskTemplates(directory: string): string[] {
  const errors: string[] = [];
  const present = new Set(readdirSync(directory));
  for (const name of ASTERISK_TEMPLATE_FILES) {
    if (!present.has(name)) errors.push(`missing ${name}`);
  }
  if (errors.length > 0) return errors;

  const files = Object.fromEntries(
    ASTERISK_TEMPLATE_FILES.map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  ) as Record<(typeof ASTERISK_TEMPLATE_FILES)[number], string>;
  const all = Object.values(files).join("\n");
  if (/MixMonitor|mixmonitor\.so|Monitor\(/i.test(all.replace("noload=app_mixmonitor.so", ""))) {
    errors.push("a recording application is enabled");
  }
  if (/allowguest\s*=\s*yes/i.test(all)) errors.push("guest SIP access is enabled");
  if (/0\.0\.0\.0\/0/.test(all)) errors.push("an identify match accepts every address");
  if (!files["extensions.conf"].includes("Stasis(")) errors.push("inbound dialplan does not enter Stasis");
  if (!files["extensions.conf"].includes("[yibo-outbound-transfer]")) errors.push("blocked outbound context is missing");
  const outbound = section(files["extensions.conf"], "yibo-outbound-transfer");
  if (!outbound.includes("Hangup()")) errors.push("outbound transfer context does not hang up");
  if (/Dial\s*\(/i.test(outbound)) errors.push("outbound transfer context places a call");
  if (!files["extensions.conf"].includes("Rejected unknown called number")) {
    errors.push("unknown called numbers are not hung up before Stasis");
  }
  if (!files["http.conf"].includes("bindaddr=127.0.0.1")) errors.push("ARI HTTP is not bound to localhost");
  if (!files["modules.conf"].includes("noload=app_mixmonitor.so")) errors.push("MixMonitor is not unloaded");
  if (!files["pjsip.conf"].includes("203.0.113.10")) errors.push("carrier match is not the documentation address");
  if (/password\s*=\s*(?!__)/i.test(files["pjsip.conf"] + files["ari.conf"])) {
    errors.push("a template contains a literal password");
  }
  return errors;
}

export function renderAsteriskTemplates(
  sourceDir: string,
  destinationDir: string,
  substitutions: Record<string, string>,
): void {
  const errors = validateAsteriskTemplates(sourceDir);
  if (errors.length > 0) throw new Error(errors.join("; "));
  mkdirSync(destinationDir, { recursive: true });
  for (const name of ASTERISK_TEMPLATE_FILES) {
    let text = readFileSync(join(sourceDir, name), "utf8");
    for (const [key, value] of Object.entries(substitutions)) {
      if (value.includes("\n") || value.includes("'")) throw new Error(`Refusing unsafe substitution for ${key}`);
      text = text.replaceAll(`__${key}__`, value);
    }
    if (/__[A-Z0-9_]+__/.test(text)) throw new Error(`${name} still contains an unsubstituted placeholder`);
    writeFileSync(join(destinationDir, name), text);
  }
}

function section(text: string, name: string): string {
  const start = text.indexOf(`[${name}]`);
  if (start < 0) return "";
  const rest = text.slice(start + name.length + 2);
  const next = rest.search(/\n\[/);
  return next < 0 ? rest : rest.slice(0, next);
}
