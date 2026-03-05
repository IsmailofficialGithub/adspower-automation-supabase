// ESM-compatible icon converter
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, '..', 'electron', 'assets', 'tray.png');
const dst = join(__dirname, '..', 'electron', 'assets', 'icon.ico');

pngToIco(src)
    .then(buf => {
        writeFileSync(dst, buf);
        console.log('✅ icon.ico created (' + buf.length + ' bytes)');
    })
    .catch(err => {
        console.error('❌ ICO conversion failed:', err.message);
        process.exit(1);
    });
