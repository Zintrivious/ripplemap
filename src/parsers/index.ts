import type { Parser } from '../types.ts';
import { actionsParser } from './actions.ts';
import { composeParser } from './compose.ts';
import { dockerfileParser } from './dockerfile.ts';
import { npmParser } from './npm.ts';
import { terraformParser } from './terraform.ts';

/** Every file is offered to each parser whose `matches` returns true. Add new parsers here. */
export const parsers: Parser[] = [dockerfileParser, terraformParser, actionsParser, npmParser, composeParser];
