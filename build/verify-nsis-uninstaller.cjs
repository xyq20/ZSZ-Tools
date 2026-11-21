const fs = require('node:fs');
const signature = Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex');

function validUninstaller(bytes) {
  if (bytes.toString('ascii', 0, 2) !== 'MZ') return false;
  for (let header = 512; header + 28 <= bytes.length; header += 512) {
    if (!bytes.subarray(header + 4, header + 20).equals(signature)) continue;
    const flags = bytes.readUInt32LE(header);
    const end = header + bytes.readUInt32LE(header + 24);
    if (flags > 15 || !(flags & 1) || (flags & 4) || end < header + 32 || end > bytes.length) return false;
    // NSIS excludes the first PE sector and the checksum field itself.
    let crc = 0xffffffff;
    for (let i = 512; i < end - 4; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return ((~crc) >>> 0) === bytes.readUInt32LE(end - 4);
  }
  return false;
}

if (require.main === module && !validUninstaller(fs.readFileSync(process.argv[2]))) {
  console.error('NSIS uninstaller failed its embedded CRC check. Stopping the Windows build.');
  process.exitCode = 1;
}
module.exports = {validUninstaller};
