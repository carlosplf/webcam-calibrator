'use strict';

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const V4L2_CTL_PATH = 'v4l2-ctl';

// Helper to run shell commands asynchronously
function runCommand(argv) {
  try {
    let proc = Gio.Subprocess.new(
      argv,
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    );

    return new Promise((resolve, reject) => {
      proc.communicate_utf8_async(null, null, (proc, res) => {
        try {
          let [ok, stdout, stderr] = proc.communicate_utf8_finish(res);
          if (!ok || proc.get_exit_status() !== 0) {
            throw new Error(stderr || 'Process failed');
          }
          resolve(stdout);
        } catch (e) {
          reject(e);
        }
      });
    });
  } catch (e) {
    return Promise.reject(e);
  }
}

const WebcamCalibratorIndicator = GObject.registerClass(
  class WebcamCalibratorIndicator extends PanelMenu.Button {

    _init() {
      super._init(0.0, 'Webcam Calibrator', false);

      this.add_child(new St.Icon({
        icon_name: 'camera-web-symbolic',
        style_class: 'system-status-icon',
      }));

      // The property is named _previewContainer
      this._previewContainer = null;
      this._device = '/dev/video0';
      this._controls = {};

      this._buildMenu();
      this._loadControls();
    }

    _buildMenu() {

      const snapshotSection = new PopupMenu.PopupMenuSection();

      // We create the container and assign it to this._previewContainer
      this._previewContainer = new St.Bin({
        style: 'width: 320px; height: 240px; background-color: black; border-radius: 4px',
        x_expand: true,
        y_expand: true,
      });

      snapshotSection.actor.add_child(this._previewContainer);

      const buttonItem = new PopupMenu.PopupMenuItem('📸');
      buttonItem.track_hover = true;
      buttonItem.connect('activate', () => {
        this._takeSnapshot();
      });
      buttonItem.add_style_class_name('snapshot-button');
      snapshotSection.addMenuItem(buttonItem);

      this.menu.addMenuItem(snapshotSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Brightness'));
      this.brightnessSlider = this._createSlider('brightness');
      this.menu.addMenuItem(this.brightnessSlider);

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('White Balance'));
      this.whiteBalanceAutoSwitch = new PopupMenu.PopupSwitchMenuItem('Auto', true);
      this.whiteBalanceAutoSwitch.connect('toggled', (item) => {
        this._setControl('white_balance_automatic', item.state ? 1 : 0);
        this.whiteBalanceSlider.setSensitive(item.state);
      });
      this.menu.addMenuItem(this.whiteBalanceAutoSwitch);
      this.whiteBalanceSlider = this._createSlider('white_balance_temperature');
      this.menu.addMenuItem(this.whiteBalanceSlider);

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Zoom'));
      this.zoomSlider = this._createSlider('zoom_absolute');
      this.menu.addMenuItem(this.zoomSlider);
    }

    async _takeSnapshot() {
      const previewPath = `${GLib.get_tmp_dir()}/webcam-snapshot.jpg`;
      const previewFile = Gio.File.new_for_path(previewPath);

      try {
        const argv = [
          'ffmpeg', '-f', 'v4l2', '-input_format', 'mjpeg',
          '-i', this._device, '-vframes', '1', '-s', '320x240',
          '-y', previewPath
        ];
        await runCommand(argv);
        
        // CHANGED: Added width and height to the new style string.
        const style = `
          width: 320px;
          height: 240px;
          background-color: black;
          background-image: url("${previewFile.get_uri()}");
          background-size: contain;
          background-repeat: no-repeat;
          background-position: center;
          border-radius: 6px;
          `;

        this._previewContainer.set_style(style);

      } catch (e) {
        Main.notifyError('Webcam Snapshot Error', e.message);
        logError(e, 'Webcam snapshot failed');
      }
    }

    // Generic slider creation
    _createSlider(controlName) {
      const slider = new Slider(0);
      slider.connect('notify::value', (sliderInstance) => {
        const value = sliderInstance.value;
        const control = this._controls[controlName];
        if (!control) return;

        const range = control.max - control.min;
        const newValue = Math.round(value * range) + control.min;

        if (!sliderInstance.dragging) {
          this._setControl(controlName, newValue);
        }
      });

      const menuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
      menuItem.add_child(slider);
      return menuItem;
    }

    async _loadControls() {
      try {
        const output = await runCommand([V4L2_CTL_PATH, '-d', this._device, '-l']);
        this._parseControls(output);
        this._updateUI();
      } catch (e) {
        Main.notifyError('Webcam Calibrator Error', `Failed to load controls: ${e.message}`);
      }
    }

    _parseControls(output) {
      this._controls = {};
      const lines = output.split('\n');
      const regex = /(?<name>\w+)\s+.*min=(?<min>-?\d+)\s+max=(?<max>-?\d+)\s+step=(?<step>\d+)\s+.*value=(?<value>-?\d+)/;

      for (const line of lines) {
        const match = line.trim().match(regex);
        if (match) {
          const { name, min, max, step, value } = match.groups;
          this._controls[name] = {
            min: parseInt(min),
            max: parseInt(max),
            step: parseInt(step),
            value: parseInt(value),
          };
        }
      }
    }

    _updateUI() {
      const brightness = this._controls.brightness;
      if (brightness) {
        this.brightnessSlider.get_first_child().value = (brightness.value - brightness.min) / (brightness.max - brightness.min);
      }

      const wbAuto = this._controls.white_balance_automatic;
      const wbTemp = this._controls.white_balance_temperature;
      if (wbAuto) {
        this.whiteBalanceAutoSwitch.setToggleState(wbAuto.value === 1);
        this.whiteBalanceSlider.setSensitive(wbAuto.value === 0);
      }
      if (wbTemp) {
        this.whiteBalanceSlider.get_first_child().value = (wbTemp.value - wbTemp.min) / (wbTemp.max - wbTemp.min);
      }

      const zoom = this._controls.zoom_absolute;
      if (zoom) {
        this.zoomSlider.get_first_child().value = (zoom.value - zoom.min) / (zoom.max - zoom.min);
      }
    }

    async _setControl(control, value) {
      try {
        await runCommand([V4L2_CTL_PATH, '-d', this._device, '-c', `${control}=${value}`]);
      } catch (e) {
        Main.notifyError('Webcam Calibrator Error', `Failed to set ${control}: ${e.message}`);
      }
    }
  });

export default class WebcamCalibratorExtension {
  constructor(metadata) {
    this._uuid = metadata.uuid;
  }

  enable() {
    this._indicator = new WebcamCalibratorIndicator();
    Main.panel.addToStatusArea(this._uuid, this._indicator);
  }

  disable() {
    this._indicator.destroy();
    this._indicator = null;
  }
}
