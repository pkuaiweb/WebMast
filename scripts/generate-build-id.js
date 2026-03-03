#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const uid = crypto.randomUUID().slice(0, 8); // 取前8位，简短易读
const timestamp = new Date().toISOString();

// 写入 build-info.json 供代码引用
const buildInfo = { uid, timestamp };
const buildInfoPath = path.join(__dirname, "..", "src", "build-info.json");
fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2) + "\n");

// 更新 manifest.json 的 description，使 chrome://extensions 详情页可见
const manifestPath = path.join(__dirname, "..", "src", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
// 保留原始描述的基础部分（去掉之前附加的 build id）
const baseDesc = manifest.description.replace(/\s*\[build:.*?\]$/, "");
manifest.description = `${baseDesc} [build:${uid}]`;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`[generate-build-id] uid=${uid}  timestamp=${timestamp}`);
