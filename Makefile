.PHONY: build run test dev
build:
	cd web && npm ci && npm run build
	go build -o warroom .
run:
	go run .
test:
	go test ./...
dev:
	cd web && npm run dev
