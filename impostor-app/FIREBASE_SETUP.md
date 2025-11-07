# Guía Paso a Paso: Configurar Firebase para Impostor Online

## Paso 1: Crear cuenta en Firebase

1. Ve a [https://console.firebase.google.com](https://console.firebase.google.com)
2. Inicia sesión con tu cuenta de Google (o créala si no tienes)
3. Haz clic en **"Agregar proyecto"** o **"Add project"**

## Paso 2: Crear el proyecto

1. **Nombre del proyecto**: Ponle un nombre (ej: "impostor-game")
2. **Google Analytics**: Puedes desactivarlo si quieres (no es necesario para el juego)
3. Haz clic en **"Crear proyecto"** / **"Create project"**
4. Espera 30-60 segundos a que termine la configuración

## Paso 3: Crear Realtime Database

1. En el menú lateral izquierdo, busca **"Realtime Database"** o **"Base de datos en tiempo real"**
2. Haz clic en **"Crear base de datos"** / **"Create database"**
3. **Ubicación**: Elige la más cercana a ti (ej: `us-central1` para Estados Unidos, `europe-west1` para Europa)
4. **Modo de seguridad**: Selecciona **"Modo de prueba"** / **"Test mode"** (lo cambiaremos después)
5. Haz clic en **"Habilitar"** / **"Enable"**

## Paso 4: Obtener las credenciales

1. Ve a **Configuración del proyecto** (⚙️) en el menú lateral
2. Haz clic en **"Configuración del proyecto"** / **"Project settings"**
3. Baja hasta la sección **"Tus aplicaciones"** / **"Your apps"**
4. Haz clic en el icono **`</>`** (Web) para agregar una app web
5. **Apodo de la app**: Ponle un nombre (ej: "Impostor Web")
6. **NO marques** "También configurar Firebase Hosting" (no lo necesitamos)
7. Haz clic en **"Registrar app"** / **"Register app"**

## Paso 5: Copiar las credenciales

Verás un código de configuración como este:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  authDomain: "tu-proyecto.firebaseapp.com",
  databaseURL: "https://tu-proyecto-default-rtdb.firebaseio.com",
  projectId: "tu-proyecto",
  storageBucket: "tu-proyecto.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdef123456"
};
```

**IMPORTANTE**: Necesitas estos valores:
- `apiKey`
- `authDomain`
- `databaseURL` ← **Este es el más importante**
- `projectId`
- `storageBucket`
- `messagingSenderId`
- `appId`

## Paso 6: Configurar reglas de seguridad

1. Ve a **Realtime Database** en el menú lateral
2. Haz clic en la pestaña **"Reglas"** / **"Rules"**
3. Reemplaza las reglas con esto:

```json
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

4. Haz clic en **"Publicar"** / **"Publish"**

⚠️ **Nota**: Estas reglas permiten lectura/escritura a cualquiera. Para producción, deberías restringirlas más, pero para probar está bien.

## Paso 7: Configurar variables de entorno

1. Abre el archivo `.env.local` en la carpeta `impostor-app`
2. Reemplaza el contenido con esto (usa TUS valores de Firebase):

```env
VITE_FIREBASE_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_FIREBASE_AUTH_DOMAIN=tu-proyecto.firebaseapp.com
VITE_FIREBASE_DATABASE_URL=https://tu-proyecto-default-rtdb.firebaseio.com
VITE_FIREBASE_PROJECT_ID=tu-proyecto
VITE_FIREBASE_STORAGE_BUCKET=tu-proyecto.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789012
VITE_FIREBASE_APP_ID=1:123456789012:web:abcdef123456
VITE_BASE_PATH=/
```

3. **Guarda el archivo**

## Paso 8: Reiniciar el servidor

1. Detén el servidor de desarrollo (Ctrl+C en la terminal)
2. Ejecuta de nuevo: `npm run dev`
3. ¡Listo! Ya debería funcionar con Firebase

## Verificación

1. Abre la app en el navegador
2. Crea una sala
3. Abre otra pestaña/ventana y únete con el mismo código
4. Deberías ver a ambos jugadores en la sala

## Solución de problemas

- **Error "Permission denied"**: Revisa las reglas de seguridad en Firebase
- **No se conecta**: Verifica que `VITE_FIREBASE_DATABASE_URL` esté correcto
- **Variables no se cargan**: Asegúrate de reiniciar el servidor después de cambiar `.env.local`


