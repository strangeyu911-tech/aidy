#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SIPS_PATH = "/usr/bin/sips";
const POWERSHELL_PATH = "powershell.exe";
const DEFAULT_SIZE = 240;

function main() {
  const args = process.argv.slice(2);
  const inputPath = readFlag(args, "--input");
  const outputPath = readFlag(args, "--output");
  const size = Number.parseInt(readFlag(args, "--size") || String(DEFAULT_SIZE), 10);

  if (!inputPath || !outputPath) {
    throw new Error("Usage: normalize-sticker-gif.js --input <path> --output <path> [--size 240]");
  }
  const resolvedInputPath = path.resolve(inputPath);
  const resolvedOutputPath = path.resolve(outputPath);
  if (!fs.existsSync(resolvedInputPath)) {
    throw new Error(`Input file does not exist: ${resolvedInputPath}`);
  }
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });

  const inputExt = path.extname(resolvedInputPath).toLowerCase();
  if (inputExt === ".gif") {
    fs.copyFileSync(resolvedInputPath, resolvedOutputPath);
    return;
  }

  const normalizedSize = Number.isInteger(size) && size > 0 ? size : DEFAULT_SIZE;
  if (process.platform === "win32") {
    normalizeWithWindowsPowerShell(resolvedInputPath, resolvedOutputPath, normalizedSize);
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("Sticker GIF normalization for non-GIF inputs requires a supported image converter.");
  }
  if (!fs.existsSync(SIPS_PATH)) {
    throw new Error(`Required tool missing: ${SIPS_PATH}`);
  }

  const result = spawnSync(SIPS_PATH, [
    "-s", "format", "gif",
    "-z", String(normalizedSize), String(normalizedSize),
    resolvedInputPath,
    "--out", resolvedOutputPath,
  ], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throw new Error(`sips gif normalization failed: ${stderr || stdout || `exit ${result.status}`}`);
  }
  if (!fs.existsSync(resolvedOutputPath)) {
    throw new Error(`GIF normalization produced no output: ${resolvedOutputPath}`);
  }
}

function normalizeWithWindowsPowerShell(inputPath, outputPath, size) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Drawing",
    "$source=$null",
    "$bitmap=$null",
    "$graphics=$null",
    "try {",
    "$source=[Drawing.Image]::FromFile($env:CYBERBOSS_STICKER_INPUT)",
    "$bitmap=New-Object Drawing.Bitmap([int]$env:CYBERBOSS_STICKER_SIZE,[int]$env:CYBERBOSS_STICKER_SIZE)",
    "$graphics=[Drawing.Graphics]::FromImage($bitmap)",
    "$graphics.Clear([Drawing.Color]::Transparent)",
    "$graphics.DrawImage($source,0,0,[int]$env:CYBERBOSS_STICKER_SIZE,[int]$env:CYBERBOSS_STICKER_SIZE)",
    "$bitmap.Save($env:CYBERBOSS_STICKER_OUTPUT,[Drawing.Imaging.ImageFormat]::Gif)",
    "} finally {",
    "if ($graphics) {$graphics.Dispose()}",
    "if ($bitmap) {$bitmap.Dispose()}",
    "if ($source) {$source.Dispose()}",
    "}",
  ].join(";");
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(POWERSHELL_PATH, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encodedCommand,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      CYBERBOSS_STICKER_INPUT: inputPath,
      CYBERBOSS_STICKER_OUTPUT: outputPath,
      CYBERBOSS_STICKER_SIZE: String(size),
    },
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throw new Error(`PowerShell GIF normalization failed: ${stderr || stdout || `exit ${result.status}`}`);
  }
  if (!fs.existsSync(outputPath)) {
    throw new Error(`GIF normalization produced no output: ${outputPath}`);
  }
}

function readFlag(args, flag) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      return String(args[index + 1] || "").trim();
    }
  }
  return "";
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  console.error(message);
  process.exit(1);
}
