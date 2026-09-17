//go:build e2e

// Two tenants, one edge. The scenario the deployment-wide realm made impossible.
//
//	SIPD_E2E=1 \
//	SIPD_E2E_OWNER_USER=1001 SIPD_E2E_OWNER_PASS=... \
//	SIPD_E2E_TENANT_REALM=tenant-b.local.test SIPD_E2E_TENANT_USER=1001 SIPD_E2E_TENANT_PASS=... \
//	  go test -tags e2e -run TestE2ETwoTenants -v .
package sipd_test

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"
)

// TestE2ETwoTenantsRegisterAtOnce proves that a second organization with its OWN SIP domain
// registers against the same sipd process, while the realm-owning organization's phone keeps
// working — and that a credential is scoped to its realm, not to the deployment.
//
// sipd never needed a change for this: `registrar.Authenticator.ForRequest` already challenges for
// the domain the REGISTER names (the To host) and looks the credential up under THAT realm, so
// SIPD_REALM is only the "no tenant matched" default. What was broken was upstream — the API handed
// an organization with no domain of its own the deployment default, which resolves to a DIFFERENT
// tenant. This test is the standing proof of the property the fix restores.
func TestE2ETwoTenantsRegisterAtOnce(t *testing.T) {
	requireE2E(t)

	tenantRealm := strings.TrimSpace(os.Getenv("SIPD_E2E_TENANT_REALM"))
	tenantUser := strings.TrimSpace(os.Getenv("SIPD_E2E_TENANT_USER"))
	tenantPass := strings.TrimSpace(os.Getenv("SIPD_E2E_TENANT_PASS"))
	if tenantRealm == "" || tenantUser == "" || tenantPass == "" {
		t.Skip("set SIPD_E2E_TENANT_REALM, SIPD_E2E_TENANT_USER and SIPD_E2E_TENANT_PASS")
	}
	ownerUser := strings.TrimSpace(os.Getenv("SIPD_E2E_OWNER_USER"))
	ownerPassword := strings.TrimSpace(os.Getenv("SIPD_E2E_OWNER_PASS"))
	if ownerUser == "" || ownerPassword == "" {
		t.Skip("set SIPD_E2E_OWNER_USER and SIPD_E2E_OWNER_PASS for an account on SIPD_REALM")
	}

	register := func(t *testing.T, realm, user, password string) int {
		t.Helper()
		ua, err := sipua.Dial(sipua.Options{
			Transport: sipua.UDP, Remote: e2eUDP, Realm: realm,
			User: user, Password: password, Timeout: 8 * time.Second,
		})
		if err != nil {
			t.Fatalf("dialing for %s@%s: %v", user, realm, err)
		}
		t.Cleanup(func() { _ = ua.Close() })
		response, err := ua.Register(sipua.RegisterOptions{Expires: 300})
		if err != nil {
			t.Fatalf("REGISTER %s@%s: %v", user, realm, err)
		}
		t.Logf("%s@%s → %d %s; Contact: %v", user, realm, response.StatusCode, response.Reason, contactList(response))
		return response.StatusCode
	}

	// The second tenant, on its own domain.
	if status := register(t, tenantRealm, tenantUser, tenantPass); status != 200 {
		t.Errorf("the second tenant's phone got %d, want 200 — a tenant with its own domain must register", status)
	}
	// The realm-owning organization, unaffected, at the same time.
	if status := register(t, e2eRealm, ownerUser, ownerPassword); status != 200 {
		t.Errorf("the realm owner's phone got %d, want 200 — the second tenant must not displace it", status)
	}
	// A credential is scoped to its realm: the second tenant's password is not an identity on the
	// first tenant's domain, even when both use the same extension number.
	if status := register(t, e2eRealm, tenantUser, tenantPass); status == 200 {
		t.Errorf("%s@%s registered with the OTHER tenant's password: realms are not isolating credentials", tenantUser, e2eRealm)
	}
}
