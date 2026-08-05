const fs = require('fs-extra');
const path = require('path');

const sourceDir = path.resolve(__dirname, '../packages/identity/src/templates');
const destDir = path.resolve(__dirname, '../packages/identity/dist/templates');

function copyHbsFiles(source, destination) {
  fs.readdir(source, { withFileTypes: true }, (err, files) => {
    if (err) {
      console.error('error reading source directory:', err);
      return;
    }

    files.forEach(file => {
      const sourcePath = path.join(source, file.name);
      const destPath = path.join(destination, file.name);

      if (file.isDirectory()) {
        copyHbsFiles(sourcePath, destPath);
      } else if (file.isFile() && sourcePath.endsWith('.hbs')) {
        fs.copy(sourcePath, destPath, err => {
          if (err) {
            console.error('error copying file:', sourcePath, err);
          }
        });
      }
    });
  });
}

copyHbsFiles(sourceDir, destDir);
