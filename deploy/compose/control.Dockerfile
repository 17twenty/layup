# Build the control service. No CGO: the binary runs on a bare distroless image.
FROM golang:1.26 AS build
WORKDIR /src
COPY go.work go.work.sum* ./
COPY protocol/go ./protocol/go
COPY services/control ./services/control
WORKDIR /src/services/control
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/layup-control ./cmd/control

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/layup-control /usr/local/bin/layup-control
EXPOSE 8787
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/layup-control"]
