# Guía para Añadir Datos de Temáticas

## Estructura de Archivos

Los datos de cada temática se almacenan en archivos JSON separados en la raíz de `impostor-app/`:

- **`futbol.json`** - Para la temática de Fútbol
- **`comida.json`** - Para la temática de Comida
- **`ciudades.json`** - Para la temática de Ciudades

## Formato de Datos

Cada archivo JSON debe contener un array de strings con el formato:

```json
[
    "Nombre, Pista",
    "Nombre, Pista",
    ...
]
```

### Ejemplo del formato:

```json
[
    "Pizza, Italiana",
    "Sushi, Japonesa",
    "Tacos, Mexicana"
]
```

**Importante:**
- El formato es: `"Nombre, Pista"` (nombre y pista separados por coma y espacio)
- Cada entrada debe estar entre comillas dobles
- El array debe estar entre corchetes `[]`
- No olvides las comas entre elementos (excepto el último)

## Dónde Añadir los Datos

### Para Comida:
Edita el archivo: **`impostor-app/comida.json`**

Reemplaza el contenido de ejemplo con tus datos reales siguiendo el formato:

```json
[
    "Pizza, Italiana",
    "Sushi, Japonesa",
    "Tacos, Mexicana",
    "Hamburguesa, Americana",
    "Paella, Española"
]
```

### Para Ciudades:
Edita el archivo: **`impostor-app/ciudades.json`**

Reemplaza el contenido de ejemplo con tus datos reales siguiendo el formato:

```json
[
    "París, Romántica",
    "Nueva York, Rápida",
    "Tokio, Moderna",
    "Londres, Lluviosa",
    "Roma, Histórica"
]
```

## Ejemplo Completo

Basándote en el formato de `futbol.json`, aquí tienes ejemplos:

### comida.json
```json
[
    "Pizza, Italiana",
    "Sushi, Japonesa",
    "Tacos, Mexicana",
    "Hamburguesa, Americana",
    "Paella, Española",
    "Pasta, Italiana",
    "Curry, India",
    "Ramen, Japonesa"
]
```

### ciudades.json
```json
[
    "París, Romántica",
    "Nueva York, Rápida",
    "Tokio, Moderna",
    "Londres, Lluviosa",
    "Roma, Histórica",
    "Barcelona, Mediterránea",
    "Madrid, Vibrante",
    "Berlín, Cultural"
]
```

## Notas Importantes

1. **Formato exacto**: Asegúrate de usar el formato `"Nombre, Pista"` con coma y espacio
2. **Comillas**: Usa comillas dobles `"` para cada string
3. **Comas**: Separa cada entrada con comas (excepto la última)
4. **Validación JSON**: Verifica que el JSON sea válido (puedes usar un validador online)
5. **Sin espacios extra**: Evita espacios innecesarios antes o después de las comas

## Cómo Funciona

El código en `src/gameData.ts` automáticamente:
1. Importa los archivos JSON
2. Parsea cada entrada usando la función `parsePlayerData()`
3. Convierte el formato `"Nombre, Pista"` a `{ name: "Nombre", clue: "Pista" }`
4. Los datos están disponibles inmediatamente en el juego

## Verificación

Después de añadir los datos:
1. Guarda los archivos JSON
2. Reinicia el servidor de desarrollo (`npm run dev`)
3. Las temáticas deberían aparecer automáticamente en el selector de temáticas del juego

