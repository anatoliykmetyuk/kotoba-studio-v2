/** Shared failed-read feedback; an error must not masquerade as an empty result. */
export function QueryError({message,retry,retrying}:{message:string;retry:()=>void;retrying:boolean}){
 return <div className="query-error" role="alert"><p>{message}</p><button className="secondary" disabled={retrying} onClick={retry}>{retrying?'Retrying…':'Retry'}</button></div>;
}
