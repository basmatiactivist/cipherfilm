// The items the viewer swipes through when it was opened from search results, a person or a memory, in that order.
import { onWipe } from "./session";

let list: string[] = [];
export const setViewerList = (ids: string[]) => { list = ids; };
export const viewerList = () => list;
onWipe(() => { list = []; });
