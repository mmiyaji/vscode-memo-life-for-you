'use strict';

import * as fs from 'fs';
import * as upath from 'upath';
import * as dateFns from 'date-fns';

export function getMemoDateDirectory(memodir: string, datePathFormat: string, date: Date = new Date()): string {
    if (!datePathFormat || datePathFormat.trim() === '') {
        return upath.normalize(memodir);
    }

    const relativeDir = dateFns.format(date, datePathFormat.trim());
    return upath.normalize(upath.join(memodir, relativeDir));
}

export function ensureMemoDateDirectory(memodir: string, datePathFormat: string, date: Date = new Date()): string {
    const targetDir = getMemoDateDirectory(memodir, datePathFormat, date);
    fs.mkdirSync(targetDir, { recursive: true });
    return targetDir;
}

export function getMemoRelativeDirectoryLabel(memodir: string, targetDir: string): string {
    const relative = upath.relative(upath.normalize(memodir), upath.normalize(targetDir));
    return relative === '' ? '.' : relative;
}
