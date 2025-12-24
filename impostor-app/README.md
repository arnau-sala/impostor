# Impostor Game

Un juego de impostor para jugar en grupo, tanto online como en un solo dispositivo.

## 🚀 Despliegue en GitHub Pages

### 1. Configurar GitHub Pages

1. Ve a tu repositorio en GitHub
2. Ve a **Settings → Pages**
3. En **Source**, selecciona **"GitHub Actions"**
4. El workflow se activará automáticamente con cada push

### 2. Configurar Variables de Entorno

Para que funcione el modo online, necesitas configurar las variables de Firebase:

1. Ve a **Settings → Secrets and variables → Actions**
2. Añade las siguientes **Repository secrets** (no variables de entorno, sino secrets):

```
VITE_FIREBASE_API_KEY=tu_api_key_aqui
VITE_FIREBASE_AUTH_DOMAIN=tu_proyecto.firebaseapp.com
VITE_FIREBASE_DATABASE_URL=https://tu-proyecto-default-rtdb.europe-west1.firebasedatabase.app
VITE_FIREBASE_PROJECT_ID=tu-proyecto
VITE_FIREBASE_STORAGE_BUCKET=tu-proyecto.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789012
VITE_FIREBASE_APP_ID=1:123456789012:web:abcdef123456
```

### 3. Configurar Firebase Database Rules

Ve a **Firebase Console → Realtime Database → Rules** y establece:

```json
{
  "rules": {
    ".read": "auth == null",
    ".write": "auth == null",
    "rooms": {
      "$roomId": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

### 4. Hacer Deploy

1. Haz push de todos los cambios al branch `main`
2. Ve a la pestaña **Actions** en GitHub
3. Espera a que termine el workflow "Deploy to GitHub Pages"
4. Tu web estará disponible en: `https://[tu-usuario].github.io/impostor/`

## 🎮 Cómo Jugar

### Modo Online:
1. Crea una sala o únete con un código
2. Espera a que se unan los jugadores (3-6)
3. Configura la temática y opciones
4. ¡Disfruta la partida!

### Modo Local (Un dispositivo):
1. Selecciona "Jugar en este dispositivo"
2. Introduce los nombres de los jugadores
3. Configura la partida
4. Pasa el dispositivo a cada jugador para que vea su rol
5. Los jugadores gestionan el resto del juego

## 🛠️ Desarrollo Local

```bash
cd impostor-app
npm install
npm run dev
```

## 📝 Tecnologías

- React + TypeScript + Vite
- Firebase Realtime Database
- GitHub Pages para hosting