import { gameData, getRandomPlayer, type PlayerWithClue } from './gameData';

export type TopicId = 'futbol' | 'comida' | 'ciudades';

export interface Topic {
  id: TopicId;
  name: string;
  hasPlayers: boolean;
}

export const topics: Record<TopicId, Topic> = {
  futbol: {
    id: 'futbol',
    name: 'Fútbol',
    hasPlayers: gameData.futbol.players.length > 0,
  },
  comida: {
    id: 'comida',
    name: 'Comida',
    hasPlayers: gameData.comida.players.length > 0,
  },
  ciudades: {
    id: 'ciudades',
    name: 'Ciudades',
    hasPlayers: gameData.ciudades.players.length > 0,
  },
};

// Función para obtener un jugador aleatorio de una categoría
export const getRandomPlayerForTopic = (topicId: TopicId): PlayerWithClue | null => {
  return getRandomPlayer(topicId);
};

