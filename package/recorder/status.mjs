import fs from 'node:fs';

// Windows readers can briefly deny replacement. Keep the previous complete
// snapshot and let the recorder's next normal heartbeat retry.
export function writeStatus(file, status) {
  const temporary = file + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(status, null, 2));
    fs.renameSync(temporary, file);
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
    return false;
  }
}
