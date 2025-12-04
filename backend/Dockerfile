FROM node:20

WORKDIR /app

# Copier les fichiers de dépendances et installer
COPY package*.json ./
RUN npm install --production

# Copier le reste du code
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
