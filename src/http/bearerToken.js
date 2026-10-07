export class BearerTokenError extends Error { constructor(){super('invalid authorization header');this.name='BearerTokenError'} }
export function parseBearerToken(value){if(typeof value!=='string'||value.length>8192)throw new BearerTokenError();const match=/^Bearer ([A-Za-z0-9._~+\/-]+)$/.exec(value);if(!match||!match[1])throw new BearerTokenError();return match[1]}
