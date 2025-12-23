import futbolData from '../futbol.json';
import comidaData from '../comida.json';
import ciudadesData from '../ciudades.json';

export interface PlayerWithClue {
  name: string;
  clue: string;
}

export interface CategoryData {
  id: string;
  name: string;
  players: PlayerWithClue[];
}

// Función helper para parsear el formato "Nombre, Pista" desde JSON
function parsePlayerData(data: string[]): PlayerWithClue[] {
  if (!Array.isArray(data)) {
    console.error('Los datos no son un array:', data);
    return [];
  }
  return data.map((item) => {
    if (typeof item !== 'string') {
      console.error('El item no es una cadena:', item);
      return { name: 'Desconocido', clue: '' };
    }
    const [name, ...clueParts] = item.split(', ');
    return {
      name: name.trim(),
      clue: clueParts.join(', ').trim(),
    };
  });
}

// Datos del juego organizados por categorías
export const gameData: Record<string, CategoryData> = {
  futbol: {
    id: 'futbol',
    name: 'Fútbol',
    players: parsePlayerData(futbolData as string[]),
  },
  comida: {
    id: 'comida',
    name: 'Comida',
    players: parsePlayerData(comidaData as string[]),
  },
  ciudades: {
    id: 'ciudades',
    name: 'Ciudades',
    players: parsePlayerData(ciudadesData as string[]),
  },
};

// Función para obtener un jugador aleatorio de una categoría
export const getRandomPlayer = (categoryId: string): PlayerWithClue | null => {
  const category = gameData[categoryId];
  if (!category || category.players.length === 0) return null;
  const randomIndex = Math.floor(Math.random() * category.players.length);
  return category.players[randomIndex];
};


