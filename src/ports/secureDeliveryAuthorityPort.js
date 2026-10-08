export function assertSecureDeliveryAuthorityPort(port) {
  if (!port || typeof port !== 'object' || typeof port.activateStudent !== 'function') {
    throw new TypeError('Secure Delivery authority port must provide activateStudent().')
  }
  return port
}
