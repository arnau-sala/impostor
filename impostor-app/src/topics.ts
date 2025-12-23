import { gameData, getRandomPlayer, type PlayerWithClue } from './gameData';

export type TopicId = 'futbol' | 'comida' | 'ciudades';

export interface Topic {
  id: TopicId;
  name: string;
  hasPlayers: boolean;
}

// Función helper para verificar si hay jugadores disponibles de forma segura
const hasPlayers = (categoryId: string): boolean => {
  try {
    const category = gameData[categoryId];
    return category && Array.isArray(category.players) && category.players.length > 0;
  } catch (error) {
    console.error(`Error al verificar jugadores para ${categoryId}:`, error);
    return false;
  }
};

export const topics: Record<TopicId, Topic> = {
  futbol: {
    id: 'futbol',
    name: 'Fútbol',
    hasPlayers: hasPlayers('futbol'),
  },
  comida: {
    id: 'comida',
    name: 'Comida',
    hasPlayers: hasPlayers('comida'),
  },
  ciudades: {
    id: 'ciudades',
    name: 'Ciudades',
    hasPlayers: hasPlayers('ciudades'),
  },
};

// Función para obtener un jugador aleatorio de una categoría
export const getRandomPlayerForTopic = (topicId: TopicId): PlayerWithClue | null => {
  return getRandomPlayer(topicId);
};

