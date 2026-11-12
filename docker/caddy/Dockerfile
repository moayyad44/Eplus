# Caddy (reverse proxy + automatic HTTPS) with the DNS plugin used to prove ownership of the domain.
# The DNS-01 challenge needs no open port on the clinic's router: the certificate is issued by writing a
# temporary TXT record through the DNS provider's API. No patient data ever goes to the DNS provider.
FROM caddy:2.11.6-builder AS build
RUN xcaddy build v2.11.6 --with github.com/caddy-dns/cloudflare@v0.2.3

FROM caddy:2.11.6
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
