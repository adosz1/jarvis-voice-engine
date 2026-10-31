FROM denoland/deno:alpine

WORKDIR /app

COPY package.json deno.json deno.lock* ./
COPY core ./core
COPY tools ./tools
COPY profiles ./profiles
COPY public ./public

EXPOSE 3000

CMD ["run", "-A", "core/server.js"]
