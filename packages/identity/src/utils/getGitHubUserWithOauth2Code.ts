const GITHUB_API_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_API_URL = "https://api.github.com/user";

async function getGitHubUserWithOauth2Code(params: {
  clientId: string;
  clientSecret: string;
  code: string;
}) {
  const { clientId, clientSecret, code } = params;
  const tokenResponse = await fetch(GITHUB_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code
    })
  });

  const tokenData = await tokenResponse.json();
  const accessToken = tokenData?.access_token;

  const userResponse = await fetch(GITHUB_USER_API_URL, {
    headers: {
      Authorization: `token ${accessToken}`
    }
  });

  return userResponse.json();
}

export { getGitHubUserWithOauth2Code };
