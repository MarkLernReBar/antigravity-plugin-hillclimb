import type { Snapshot } from './model.js'
import type { Action } from './actions.js'
/** A MAP-Elites cell the search recorded when it expanded from it. */
export interface EliteCell {island:number;bins:number[];parent:string|null;score:number|null;attempts:number}
/** Which search the rows come from, and how many siblings the run holds. */
export interface LiveSearch {id:string;climber:string|null;featureDimensions:string[]|null;count:number}
export interface LiveData {
  engine:'repo'|'search'|null;baseline:number|null;best:number|null;target:number|null;
  rows:{id:string;parent:string|null;score:number|null;label:string;at:string}[];
  holdout:string|null;
  /** Absent for a repo climb and for a reading cached before this field existed. */
  search?:LiveSearch|null;
  worker?:{phase:string;liveness:string;nextAction:string;retries:number;heartbeatAt:string|null};
  /** Cells the engine itself journaled; empty (or absent) means it recorded none. */
  elite?:EliteCell[];
}
export interface ViewProps {data:Snapshot;track:string;selected:string|null;select:(key:string|null)=>void;act:(a:Action)=>Promise<void>;configure?:(key:string,engine:'repo'|'search')=>Promise<void>;dispatch:(key:string,engine:'repo'|'search')=>Promise<void>;live:(key:string)=>Promise<LiveData>}
