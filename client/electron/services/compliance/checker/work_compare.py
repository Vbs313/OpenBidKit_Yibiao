# -*- coding: utf-8 -*-
import sys, os, glob
BASE = r'C:\Users\HUAWEI\Desktop\项目\MX\OpenBidKit_Yibiao\client\work'
sys.path.insert(0, r'C:\Users\HUAWEI\Desktop\项目\MX\OpenBidKit_Yibiao\client\electron\services\compliance\checker')
from checks.cross_check import extract_scoring_items
for p in sorted(glob.glob(os.path.join(BASE, '*.md'))):
    t = open(p, encoding='utf-8').read()
    n = t.count('|')
    tbl = sum(1 for l in t.splitlines() if l.strip().startswith('|') and l.strip().endswith('|'))
    items = extract_scoring_items(t)
    print('%-22s chars=%6d pipes=%5d tablerows=%4d extracted=%2d' % (os.path.basename(p), len(t), n, tbl, len(items)))
    for it in items[:12]:
        print('     [%s] %s' % (it.get('score'), (it.get('name') or '')[:56]))
