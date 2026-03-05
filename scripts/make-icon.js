'use strict';
const pngToIco = require('png-to-ico');
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'electron', 'assets', 'tray.png');
const dst = path.join(__dirname, '..', 'electron', 'assets', 'icon.ico');

pngToIco(src)
    .then(buf => {
        fs.writeFileSync(dst, buf);
        console.log('✅ icon.ico created (' + buf.length + ' bytes)');
    })
    .catch(err => {
        console.error('❌ ICO conversion failed:', err.message);
        process.exit(1);
    });
