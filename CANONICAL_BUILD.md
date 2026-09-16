# Canonical build

This repository is based on the reviewed `stremio-art-bridge` implementation and includes the deployment, resolver, TPDb, cache, admin, and reliability changes accumulated during this project. It is intended to replace previous ZIP variants; do not merge it with an older `stremio-art-proxy` archive.

Included changes:

- First poster request never blocks on ThePosterDB; TPDb enrichment runs as low-priority background work.
- Persistent TPDb state with queued/running/found/not_found/error, retry scheduling, negative caching, and periodic sweep.
- TPDb English + Original filtering, movie/show-cover filtering, actual set parsing, and identifier-aware candidate searches.
- Fix for TPDb search-page arbitrary asset selection.
- Provider/source-aware local image cache filenames.
- TPDb and manual overrides cached indefinitely.
- Previous cached art file removed when a selection is replaced.
- Resolver selection stage/reason stored and shown in admin.
- Adaptive Cache-Control for fallback posters, capped by TPDb retry time.
- Explicit TVDB `includesText=false` handling for textless backdrops.
- MetaHub backdrop uses `/background/`.
- Admin cached-image preview endpoint.
- Browser login/session for the admin UI.
- Bind-mount storage via `${DOCKER_DATA_DIR}/art-proxy`.
- Permission-safe Docker startup with PUID/PGID fallback.
- Host networking with `.env`-controlled `PORT`.
- CPU/memory/PID Docker limits remain configurable from `.env`.
- Multi-architecture GHCR publication (`linux/amd64`, `linux/arm64`).
- Graceful shutdown and live/background concurrency separation.
