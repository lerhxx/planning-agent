#!/usr/bin/env node
/**
 * Workaround for a bug in @copilotkit/react-core@1.77.0.
 *
 * Root cause
 * ----------
 * Inside the internal text-input component, `isComposingRef` (a `useRef`) is
 * declared AFTER an early `if (children) return` that powers the
 * `CopilotChatInput` slot / `children` API. Because TravelChatInput uses that
 * slot API (`args.textArea`, `args.sendButton` -> `children(childProps)`), the
 * component always takes the early-return path and NEVER initializes
 * `isComposingRef`. The IME composition handlers (onCompositionStart/End) that
 * reference it then throw:
 *
 *     Uncaught ReferenceError: Cannot access 'isComposingRef' before initialization
 *
 * which crashes the SDK input and leaves the textarea unresponsive after a send.
 *
 * This script hoists the `const isComposingRef = useRef(false)` declaration
 * ABOVE `const BoundTextArea` so it is initialized on every render path,
 * including the slot/children path. It is idempotent and version-robust:
 *  - if the declaration is already before `BoundTextArea`, it is a no-op;
 *  - if the expected markers are absent (e.g. a fixed upstream version), it
 *    skips the file instead of failing the install.
 *
 * NOTE: This is a node_modules hot-patch applied on every `npm install` via the
 * project's `postinstall` script. It does not modify any source under version
 * control. When @copilotkit/react-core ships a fix, delete this file and the
 * `postinstall` entry.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const TARGETS = [
  {
    file: "node_modules/@copilotkit/react-core/dist/copilotkit-CP9qPAqV.mjs",
    decl: "const isComposingRef = useRef(false);",
  },
  {
    file: "node_modules/@copilotkit/react-core/dist/copilotkit-CFPkj9B9.cjs",
    decl: "const isComposingRef = (0, react.useRef)(false);",
  },
];

const BOUND_TEXTAREA = "const BoundTextArea = renderSlot(textArea, CopilotChatInput.TextArea, {";
const ENSURE_MEASUREMENTS = "const ensureMeasurements";

function leadingWhitespace(line) {
  const trimmedStart = line.length - line.replace(/^\s+/, "").length;
  return line.slice(0, trimmedStart);
}

function isAlreadyFixed(text, decl) {
  const btaIdx = text.indexOf(BOUND_TEXTAREA);
  const declIdx = text.indexOf(decl);
  if (btaIdx === -1 || declIdx === -1) return true; // markers missing -> do not touch
  return declIdx < btaIdx; // declaration already precedes BoundTextArea
}

function applyHoist(text, decl) {
  const lines = text.split("\n");

  const btaIdx = lines.findIndex((l) => l.includes(BOUND_TEXTAREA));
  if (btaIdx === -1) return text; // nothing to do

  const lead = leadingWhitespace(lines[btaIdx]);

  // Remove the ORIGINAL declaration that sits immediately before `ensureMeasurements`
  // (it is after the early return and never initialized on the slot path).
  let removed = false;
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i].trimEnd() === lead + decl) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && lines[j].includes(ENSURE_MEASUREMENTS)) {
        lines.splice(i, 1);
        removed = true;
        break;
      }
    }
  }
  if (!removed) return text; // original declaration not where expected -> do not touch

  // Re-locate BoundTextArea (index may have shifted after deletion) and insert
  // the declaration BEFORE it, so it is always initialized.
  const idx = lines.findIndex((l) => l.includes(BOUND_TEXTAREA));
  lines.splice(idx, 0, lead + decl);

  return lines.join("\n");
}

let changed = false;
for (const target of TARGETS) {
  const p = join(root, target.file);
  if (!existsSync(p)) {
    console.warn(`[patch-copilotkit] skip (not found): ${target.file}`);
    continue;
  }
  try {
    const text = readFileSync(p, "utf8");
    if (isAlreadyFixed(text, target.decl)) {
      console.log(`[patch-copilotkit] ok (already fixed or N/A): ${target.file}`);
      continue;
    }
    const out = applyHoist(text, target.decl);
    if (out !== text) {
      writeFileSync(p, out);
      changed = true;
      console.log(`[patch-copilotkit] patched: ${target.file}`);
    }
  } catch (err) {
    // Never break `npm install`.
    console.warn(`[patch-copilotkit] WARNING: failed to patch ${target.file}: ${err?.message ?? err}`);
  }
}

if (changed) console.log("[patch-copilotkit] CopilotKit isComposingRef TDZ fix applied.");
process.exit(0);
