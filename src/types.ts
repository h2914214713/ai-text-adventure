export interface Item {
  name: string;
  qty?: number;
}

export interface State {
  hp: number;
  hpMax: number;
  gold: number;
  stamina: number;
  staminaMax: number;
  items: Item[];
  location: string;
  flags: Record<string, number | string | boolean>;
  knownNames: string[];
  memories: { turn: number; text: string }[];
  turn: number;
  scene: string;
}

export interface EndingDef {
  id: string;
  title: string;
  /** hp_zero | flag | item | turns_flag */
  when: 'hp_zero' | 'flag' | 'item' | 'turns_flag';
  key?: string;
  value?: number | string | boolean;
  turns?: number;
  text: string;
}

export interface Template {
  id: string;
  title: string;
  subtitle: string;
  tag: string;
  accent: string;
  worldview: string;
  goal: string;
  tone: string;
  initialState: State;
  npcs: { name: string; role: string }[];
  itemPool: { name: string; desc: string }[];
  endings: EndingDef[];
  opening: { scene: string; narration: string; choices: string[] };
  /* ---- 离线模式（未配置大模型密钥）使用的叙事素材 ---- */
  bank: {
    places: string[];
    senses: string[];
    npcLines: string[];
    twists: string[];
    outcomes: string[];
    choices: string[];
  };
}

export interface ModelTurn {
  scene: string;
  narration: string;
  choices: string[];
  state_delta: {
    hp?: number;
    gold?: number;
    stamina?: number;
    items_gain?: string[];
    items_lose?: string[];
    flags?: Record<string, number | string | boolean>;
    location?: string;
  };
  ending?: null | { title: string; type: string; text: string };
  new_characters?: { name: string; role: string }[];
}
