import tempfile
from bs4 import BeautifulSoup
import requests
import json
import re
import subprocess
import os
from urllib.request import urlretrieve
import py7zr
import os
import iniparse
import shutil
import io

class cd:
  """Context manager for changing the current working directory"""
  def __init__(self, newPath):
    self.newPath = os.path.expanduser(newPath)
  def __enter__(self):
    self.savedPath = os.getcwd()
    os.chdir(self.newPath)
  def __exit__(self, etype, value, traceback):
    os.chdir(self.savedPath)

def file_list():
  try:
    files = {}
    found = False
    resp = requests.get('https://sourceforge.net/projects/sfall/files/sfall/')
    soup = BeautifulSoup(resp.content, "lxml")
    for tag in soup.find_all('script'):
      for tc in tag.contents:
        if 'net.sf.files' in tc:
          m = tc.split('net.sf.staging_days')[0].strip()
          m = m.replace('net.sf.files = ', '').rstrip(';')
          jfiles = json.loads(m)
          found = True
          break
      if found:
        break

    for jf in jfiles:
      if 'sfall_' in jf:
        files[jf] = jfiles[jf]['download_url']
    print(files)
    return files
  except:
    return {}

def get_latest():
  try:
    resp = requests.get('https://sourceforge.net/projects/sfall/best_release.json')
    release = resp.json()['release']
    latest = {}
    latest['ver'] = release['filename'].split('_')[-1].rsplit('.',1)[0]
    latest['url'] = release['url']
    file_list()
    return latest
  except:
    return {'ver': 'unknown', 'url': ''}

def get_current(path):
  proc1 = subprocess.Popen(['strings', os.path.join(path, 'ddraw.dll')], stdout=subprocess.PIPE)
  proc2 = subprocess.Popen(['grep', '#SFALL'], stdin=proc1.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
  proc1.stdout.close() # Allow proc1 to receive a SIGPIPE if proc2 exits.
  out, err = proc2.communicate()
  ver = out.split()[1].decode('utf-8')
  return ver

def download(url, game_path):
  print("update start")
  with tempfile.TemporaryDirectory(prefix='f2gm-') as tmpdir:
    dst = os.path.join(tmpdir, 'sfall.7z')
    urlretrieve(url, dst)
    with cd(tmpdir):
      with py7zr.SevenZipFile('sfall.7z', mode='r') as z:
        z.extractall()
      with open(os.path.join(game_path, 'ddraw.ini')) as fh:
        old_ini = iniparse.INIConfig(fh, optionxformvalue=None) # iniparse keep case for new keys
      with open('ddraw.ini') as fh:
        new_ini = iniparse.INIConfig(fh, optionxformvalue=None)
      for s in old_ini:
        for k in old_ini[s]:
          new_ini[s][k] = old_ini[s][k]
      content = str(new_ini)
      content = content.replace('\n', '\r\n') # for old windows users
      content = content.replace(' = ', '=') # iniparse adds spaces around new keys
      with open('ddraw.ini', 'w') as fh:
        fh.write(content)
      os.remove('sfall.7z')
      shutil.copytree(tmpdir, game_path, dirs_exist_ok=True)
  print("update finished")
