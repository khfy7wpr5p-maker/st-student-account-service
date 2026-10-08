export function assertAuthDirectory(directory) {
  if (!directory || typeof directory !== 'object' || typeof directory.accountExistsByEmail !== 'function') {
    throw new TypeError('auth directory must provide accountExistsByEmail().')
  }
  return directory
}
