import re, zipfile

z = zipfile.ZipFile(r'C:\Users\User\AppData\Local\Temp\opencode\decor_icons.zip')
stems = sorted(n[:-5] for n in z.namelist() if n.endswith('.webp'))

lines = open(r'C:\Users\User\AppData\Local\Temp\opencode\decor_nomatch.txt', encoding='utf-8').read().splitlines()
rows = []
for l in lines:
    label, did = [x.strip() for x in l.split('||')]
    rows.append((did, label))
print('unmatched:', len(rows))

def show(title, pred, cap=40):
    print(f'--- {title} ---')
    n = 0
    for did, label in rows:
        if pred(did, label) and n < cap:
            print(f'{label} || {did}')
            n += 1
    print()

show('statue*', lambda d, l: l.lower().startswith('statue') or d.lower().startswith('statue'))
show('Plank*', lambda d, l: 'plank' in l.lower())
show('zoo*', lambda d, l: l.lower().startswith('zoo'))
show('valentine*', lambda d, l: l.lower().startswith('valentine'))
show('halloween*', lambda d, l: 'halloween' in l.lower())
show('green*', lambda d, l: l.lower().startswith('green'))
show('flowerbed*', lambda d, l: 'flowerbed' in l.lower().replace(' ', ''))
show('surf*', lambda d, l: l.lower().startswith('surf'))
show('arabic*', lambda d, l: l.lower().startswith('arabic'))
show('Expedition*', lambda d, l: l.lower().startswith('expedition'))
show('Merge*', lambda d, l: 'merge' in l.lower())
show('FinalReward*', lambda d, l: l.lower().startswith('finalreward'))
show('Helix*', lambda d, l: 'helix' in l.lower())
show('thanksgiving*', lambda d, l: l.lower().startswith('thanksgiving'))

print('=== theme stems in pack ===')
for kw in ['valentine', 'love_', 'heart', 'cupid', 'halloween', 'zoo_', 'surf',
           'arabian', 'arab', 'plank', 'statue', 'adventure', 'explore',
           'expedition', 'merge', 'candy', 'pirate', 'snow', 'ice_']:
    hits = [s for s in stems if kw in s]
    print(f'{kw} ({len(hits)}): {hits[:10]}')
