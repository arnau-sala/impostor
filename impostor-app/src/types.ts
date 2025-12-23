export type GamePhase =
  | 'lobby'
  | 'wordReveal'
  | 'clue'
  | 'voting'
  | 'tiebreaker'
  | 'reveal'
  | 'finished';

export interface PlayerState {
  id: string;
  name: string;
  isHost: boolean;
  isImpostor: boolean;
  alive: boolean;
  clue?: string;
  vote?: string;
  readyForRound?: boolean;
}

export interface GameClue {
  id: string;
  playerId: string;
  word: string;
  round: number;
  createdAt: number;
}

export interface GameState {
  code: string;
  topic: string;
  secretWord: string;
  selectedPlayer?: string; // Nombre del jugador seleccionado
  selectedPlayerClue?: string; // Pista del jugador seleccionado
  showClue: boolean; // Si se debe mostrar la pista
  allowVoteChange: boolean; // Si se permite cambiar el voto después de votar (por defecto true)
  singleWordOnly: boolean; // Si solo se permite una palabra en las pistas (por defecto false)
  voteDisplayMode: 'hidden' | 'count' | 'visible'; // Modo de visualización de votos: ocultos, recuento visible, votos visibles
  timeLimit?: number; // Tiempo límite por turno en segundos (undefined = sin límite)
  votingTimeLimit?: number; // Tiempo límite para votaciones en segundos (undefined = sin límite)
  hostId: string;
  impostorId?: string;
  players: PlayerState[];
  phase: GamePhase;
  currentTurnIndex: number;
  firstSpeakerIndex?: number; // Índice del primer jugador que habló (se mantiene toda la partida)
  round: number;
  clues: GameClue[];
  votes: Record<string, string>;
  confirmedVotes?: string[]; // IDs de jugadores que han confirmado su voto
  tiebreaker?: {
    tiedPlayers: string[]; // IDs de jugadores empatados
    voteCount: number; // Número de votos con los que empataron
    previousVotes: Record<string, string>; // Votos de la votación anterior
  };
  elimination?: {
    targetId: string;
    wasImpostor: boolean;
  };
  winner?: 'impostor' | 'civilians';
  updatedAt: number;
}

export interface JoinRequestPayload {
  player: PlayerState;
}

export interface JoinResponsePayload {
  targetId: string;
  accepted: boolean;
  reason?: string;
}

export interface VotePayload {
  voterId: string;
  targetId: string;
}

export interface CluePayload {
  playerId: string;
  word: string;
}

export interface ReadyPayload {
  playerId: string;
  ready: boolean;
}

export interface LeavePayload {
  playerId: string;
}

export type BroadcastEventPayload =
  | { type: 'STATE_UPDATE'; state: GameState }
  | { type: 'JOIN_REQUEST'; payload: JoinRequestPayload }
  | { type: 'REQUEST_STATE'; playerId: string }
  | { type: 'SUBMIT_CLUE'; payload: CluePayload }
  | { type: 'SUBMIT_VOTE'; payload: VotePayload }
  | { type: 'READY_FOR_ROUND'; payload: ReadyPayload }
  | { type: 'CLEAR_VOTE'; playerId: string }
  | { type: 'CONFIRM_VOTE'; playerId: string }
  | { type: 'JOIN_RESPONSE'; payload: JoinResponsePayload }
  | { type: 'PLAYER_LEAVE'; payload: LeavePayload };

