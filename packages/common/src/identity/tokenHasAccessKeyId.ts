import { Access, decodeToken, TokenUseEnum } from ".";

function tokenHasAccessKeyId(token: string, accessKeyId: string) {
  const decodedToken = decodeToken<TokenUseEnum.ACCESS>(token);
  const accessKeyIds = decodedToken.access?.map((a: Access) => a.accessKeyId);
  return accessKeyIds.includes(accessKeyId);
}

export { tokenHasAccessKeyId };
