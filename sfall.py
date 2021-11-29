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
import pefile
import threading
import queue
import datetime
from variables import *
from common import cd

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
  pe = pefile.PE(os.path.join(path, 'ddraw.dll'))
  ver = pe.FileInfo[0][0].StringTable[0].entries[b"FileVersion"]
  ver = ver.decode('ascii')
  return ver

def download(url, game_path):
  print("update start")

  with tempfile.TemporaryDirectory(prefix='zax-') as tmpdir:
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
      backup(game_path, tmpdir)
      shutil.copytree(tmpdir, game_path, dirs_exist_ok=True)
  print("update finished")

def backup(game_dir, tmp_dir, backup_dir = backup_dir):
  backup_dir = os.path.join(backup_dir, datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S"))
  with cd(tmp_dir):
    for root, dirs, files in os.walk(os.curdir):
      for f in files:
        f_relpath = os.path.join(root, f)
        f_gamepath = os.path.join(game_dir, f_relpath)
        if os.path.isfile(f_gamepath):
          f_backpath = os.path.join(backup_dir, f_relpath)
          os.makedirs(os.path.dirname(f_backpath), exist_ok=True)
          shutil.copy(f_gamepath, f_backpath)
  print("backed up to {}".format(backup_dir))

def launch_latest_check(gui_queue):
  print("start background thread")
  def launch_latest_check2(gui_queue):
    gui_queue.put({'type': 'sfall_latest', 'value': get_latest()})
  try:
    threading.Thread(target=launch_latest_check2, args=(gui_queue,), daemon=True).start()
  except:
    print("failed to start sfall latest check thread!")
  print("started background thread")

def handle_update_ui(window, sfall_current, message=None, sfall_latest = None):
  if not sfall_latest:
    sfall_latest = message['value']
  window['txt_sfall_latest'](value=sfall_latest['ver'])
  window['btn_sfall_check'](visible=False)
  window['txt_sfall_check_placeholder'](visible=True)
  if sfall_current != sfall_latest['ver']:
    window['txt_sfall_update_placeholder'](visible=False)
    window['btn_sfall_update'](visible=True, disabled=False)
  else:
    window['txt_sfall_update_placeholder'](visible=True)
    window['btn_sfall_update'](visible=False, disabled=True)
    window['txt_sfall_current'](value=sfall_latest['ver'])
  return sfall_latest

def update(window, sfall_latest, game_path):
  download(sfall_latest['url'], game_path)
  window['txt_sfall_update_placeholder'](visible=True)
  window['btn_sfall_update'](visible=False, disabled=True)
  window['txt_sfall_current'](value=sfall_latest['ver'])
