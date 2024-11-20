FROM node:18.20.5-bullseye-slim
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV production
ENV PORT 3000
WORKDIR /usr/src/app
COPY --chown=node:node . .
RUN npm install
RUN npm run telemetry-disable
RUN npm run build
USER node
EXPOSE 3000
CMD ["dumb-init", "npm", "start"]
HEALTHCHECK --interval=10s --timeout=2s --start-period=15s \  
CMD curl -fs http://localhost:3000/api/health || exit 1