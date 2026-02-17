
export interface ContactRow {
  relatie: string;
  contactpersoon: string;
  onderwerp: string;
  telefoonnummer: string;
}

export enum AppStatus {
  IDLE = 'IDLE',
  LOADING = 'LOADING',
  READING = 'READING',
  DIALING = 'DIALING',
  ERROR = 'ERROR'
}
