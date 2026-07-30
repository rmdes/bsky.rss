# certs/

`sectigo-public-server-authentication-ca-ov-r36.pem` — the intermediate CA
certificate for `rappel.conso.gouv.fr` (used by the `rappel-consofix-fr` bot).
That server doesn't send its own intermediate certificate (a real server
misconfiguration, confirmed directly via `openssl s_client -showcerts` and
`curl` on the host - both fail identically with "unable to verify the first
certificate"), so Node has no way to build the chain up to an already-trusted
root without this file.

Fetched from Sectigo's own certificate repository via the leaf certificate's
AIA (Authority Information Access) extension:
`http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt`

Verified to actually complete the chain before adding it:
```
openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt \
  -untrusted certs/sectigo-public-server-authentication-ca-ov-r36.pem \
  <leaf-cert> # -> OK
```

Supplied to Node via `NODE_EXTRA_CA_CERTS` (see `docker-compose.fleet.example.yml`)
rather than disabling certificate verification - this adds the one legitimate
missing link to the existing trust store, it does not weaken it.
