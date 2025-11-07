# Impostor Online (versión web móvil)

Prototipo funcional del juego social "Impostor" optimizado para móviles. Los jugadores se unen mediante un código de sala, comparten pistas sobre una palabra secreta y votan para descubrir al impostor.

## Requisitos previos

- Node.js 18 o superior
- Una cuenta de [Firebase](https://firebase.google.com/) con Realtime Database configurado (consulta `FIREBASE_SETUP.md` para más detalles)

## Configuración rápida

1. Instala las dependencias:

   ```bash
   npm install
   ```

2. Crea un archivo `.env.local` en la carpeta `impostor-app` con tu configuración de Firebase:

   ```bash
   VITE_FIREBASE_API_KEY=TU_API_KEY
   VITE_FIREBASE_AUTH_DOMAIN=TU_AUTH_DOMAIN
   VITE_FIREBASE_DATABASE_URL=TU_DATABASE_URL
   VITE_FIREBASE_PROJECT_ID=TU_PROJECT_ID
   VITE_FIREBASE_STORAGE_BUCKET=TU_STORAGE_BUCKET
   VITE_FIREBASE_MESSAGING_SENDER_ID=TU_MESSAGING_SENDER_ID
   VITE_FIREBASE_APP_ID=TU_APP_ID
   VITE_BASE_PATH=/
   ```

   Consulta `FIREBASE_SETUP.md` para obtener estas credenciales paso a paso.

   - Para GitHub Pages en `https://usuario.github.io/impostor/`, usa `VITE_BASE_PATH=/impostor/`.

3. Inicia el entorno de desarrollo:

   ```bash
   npm run dev
   ```

   La aplicación estará disponible en `http://localhost:5173`.

## Flujo de juego

1. El anfitrión crea una sala y comparte el código.
2. Los demás jugadores se unen con su nombre y el código.
3. El anfitrión define la temática y la palabra secreta y empieza la partida.
4. En la fase de pistas, cada jugador comparte una palabra relacionada (excepto el impostor que no conoce la palabra).
5. Tras una ronda de pistas, se abre la votación para eliminar a un jugador.
6. El juego revela si el eliminado era el impostor y continúa hasta que el impostor es descubierto o solo quedan dos jugadores vivos.

## Comandos disponibles

- `npm run dev`: inicia el modo desarrollo con recarga en caliente.
- `npm run build`: genera la versión de producción en `dist/`.
- `npm run preview`: sirve la build de producción localmente.

## Despliegue en GitHub Pages

1. Establece `VITE_BASE_PATH=/impostor/` (sustituye `impostor` por el nombre real del repositorio si es distinto).
2. Ejecuta `npm run build`.
3. Publica el contenido de la carpeta `dist/` en la rama `gh-pages` (puedes usar [GitHub Actions](https://github.com/actions/starter-workflows/blob/main/pages/static.yml) o un deploy manual).

> Nota: debido a que se trata de una aplicación solo frontend, las credenciales de Firebase pueden estar en el cliente, pero recuerda configurar las reglas de seguridad de Realtime Database para evitar modificaciones indeseadas.

## Próximos pasos sugeridos

- Añadir persistencia en Firebase (p. ej. almacenamiento de partidas y métricas).
- Implementar transferencia de anfitrión si el creador abandona la sala.
- Añadir control de empates durante las votaciones (ej. segundas rondas automáticas o desempate del anfitrión).
- Preparar una variante con soporte para escritorio.

## Atribuciones

- **Favicon**: Impostor by Luis Prado from [Noun Project](https://thenounproject.com/browse/icons/term/impostor/) (CC BY 3.0)

