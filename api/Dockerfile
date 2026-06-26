FROM node:20-alpine

# შევქმნათ ჯგუფი და მომხმარებელი
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# ჯერ დავაკოპიროთ package ფაილები (Caching-ისთვის უკეთესია)
COPY package*.json ./
RUN npm install --omit=dev

# დავაკოპიროთ დანარჩენი კოდი
COPY . .

# მივანიჭოთ ფაილებზე წვდომა ახალ მომხმარებელს
RUN chown -R appuser:appgroup /app

# გადავიდეთ ამ მომხმარებელზე
USER appuser

EXPOSE 3000
CMD ["node", "server.js"]
