const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const files = ['manifest.json', 'bridge.js', 'background.js', 'content.js'];
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const parts = [], directory = [];
let offset = 0;
for (const filename of files) {
  const content = fs.readFileSync(path.join(root, 'extension', filename));
  const name = Buffer.from('follow-studio/' + filename), crc = crc32(content);
  const local = Buffer.alloc(30), central = Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  parts.push(local, name, content);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  directory.push(central, name); offset += local.length + name.length + content.length;
}
const cd = Buffer.concat(directory), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
const dist = path.join(root, 'dist'); fs.mkdirSync(dist, {recursive: true});
fs.writeFileSync(path.join(dist, 'follow-studio-chrome.zip'), Buffer.concat([...parts, cd, end]));
console.log('Created dist/follow-studio-chrome.zip (extension files only)');
