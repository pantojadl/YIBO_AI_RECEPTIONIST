import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAsteriskTemplates, validateAsteriskTemplates } from "../../src/launch/asterisk-templates.js";

const root = join(process.cwd(), "deploy/asterisk");
const temps: string[] = [];

afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Asterisk inbound templates", () => {
  it("accepts the versioned inbound-only templates", () => {
    expect(validateAsteriskTemplates(root)).toEqual([]);
  });

  it("renders placeholders without leaving them in the output", () => {
    const destination = mkdtempSync(join(tmpdir(), "yibo-asterisk-"));
    temps.push(destination);
    renderAsteriskTemplates(root, destination, {
      YIBO_PUBLIC_IP: "203.0.113.20",
      YIBO_TEST_EXTENSION_PASSWORD: "lab-password",
      YIBO_ARI_PASSWORD: "lab-ari",
      YIBO_LAB_DID: "+15555550100",
    });
    const extensions = readFileSync(join(destination, "extensions.conf"), "utf8");
    const pjsip = readFileSync(join(destination, "pjsip.conf"), "utf8");
    expect(extensions).toContain("+15555550100");
    expect(extensions).not.toContain("__YIBO_");
    expect(pjsip).toContain("external_media_address=203.0.113.20");
    expect(pjsip).not.toContain("PJSIP/+");
    expect(extensions).not.toMatch(/Dial\(PJSIP\/\$\{EXTEN\}@/);
  });

  it("rejects a template that dials out of the transfer context", () => {
    const destination = mkdtempSync(join(tmpdir(), "yibo-asterisk-bad-"));
    temps.push(destination);
    renderAsteriskTemplates(root, destination, {
      YIBO_PUBLIC_IP: "203.0.113.20",
      YIBO_TEST_EXTENSION_PASSWORD: "lab-password",
      YIBO_ARI_PASSWORD: "lab-ari",
      YIBO_LAB_DID: "+15555550100",
    });
    const extensionsPath = join(destination, "extensions.conf");
    writeFileSync(extensionsPath, readFileSync(extensionsPath, "utf8").replace(
      "exten => _X.,1,NoOp(Outbound transfer blocked ${EXTEN})\n same => n,Hangup()",
      "exten => _X.,1,Dial(PJSIP/${EXTEN})",
    ));
    expect(validateAsteriskTemplates(destination).join(" ")).toMatch(/outbound transfer context places a call/);
  });
});
