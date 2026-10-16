# SwitchGuard demo image. Secrets (DETECTIF_API_TOKEN, REVIEWER_TOKEN) are runtime environment
# variables only — never baked into the image or sent to the browser.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY product ./product
RUN npm run build && npm test

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/three/build ./node_modules/three/build
COPY --from=build /app/node_modules/@mediapipe/tasks-vision ./node_modules/@mediapipe/tasks-vision
COPY --from=build /app/product/package.json ./product/package.json
COPY --from=build /app/product/public ./product/public
COPY --from=build /app/product/dist/product/server ./product/dist/product/server
COPY --from=build /app/product/dist/product/browser ./product/dist/product/browser
COPY --from=build /app/product/dist/src ./product/dist/src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "product/dist/product/server/main.js"]
