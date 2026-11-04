import type { Parser } from '../types.ts';
import { actionsParser } from './actions.ts';
import { composeParser } from './compose.ts';
import { dockerfileParser } from './dockerfile.ts';
import { goModParser } from './gomod.ts';
import { helmParser } from './helm.ts';
import { kubernetesParser } from './kubernetes.ts';
import { npmParser } from './npm.ts';
import { pipelinesParser } from './pipelines.ts';
import { pythonParser } from './python.ts';
import { terraformParser } from './terraform.ts';

/** Every file is offered to each parser whose `matches` returns true. Add new parsers here. */
export const parsers: Parser[] = [dockerfileParser, terraformParser, actionsParser, npmParser, composeParser, kubernetesParser, helmParser, goModParser, pythonParser, pipelinesParser];
