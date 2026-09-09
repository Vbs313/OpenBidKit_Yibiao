# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.abspath('.'))
from checks.cross_check import extract_scoring_items
MD = r'C:\Users\HUAWEI\Desktop\项目\MX\OpenBidKit_Yibiao\client\work\zy-tender.md'
text = open(MD, encoding='utf-8').read()
items = extract_scoring_items(text)
print('chars=%d  extracted=%d' % (len(text), len(items)))
for it in items:
    print('  [%s] %s' % (it.get('score'), it.get('name')))
