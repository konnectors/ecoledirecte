const {
  BaseKonnector,
  requestFactory,
  saveFiles,
  log,
  errors,
  mkdirp
} = require('cozy-konnector-libs')
const cheerio = require('cheerio')
const baseUrl = 'https://api.ecoledirecte.com/v3'
const bluebird = require('bluebird')
const subYears = require('date-fns/sub_years')
const subDays = require('date-fns/sub_days')
const lastDayOfMonth = require('date-fns/last_day_of_month')
const setMonth = require('date-fns/set_month')
const eachDay = require('date-fns/each_day')
const isSunday = require('date-fns/is_sunday')
const chunk = require('lodash/chunk')
const format = require('date-fns/format')

class EcoleDirecteConnector extends BaseKonnector {
  constructor() {
    super()
    this.requestInstance = requestFactory({
      // debug: true,
      cheerio: false,
      json: true,
      jar: true
    })
  }

  async fetch(fields) {
    log('info', 'Authenticating ...')
    await this.authenticate(fields.login, fields.password)
    log('info', 'Successfully logged in')

    await this.initEtablissementFolder(fields)
    await this.initElevesFolders(fields)

    // first fetch future homeworks for all eleves
    for (const eleve of this.account.profile.eleves) {
      const eleveFolder = this.folders[eleve.id]
      const dates = await this.fetchFutureHomeWorkDates(eleve)
      await bluebird.map(
        dates,
        date => this.fetchEleveHomeWorks(eleve, eleveFolder, date),
        { concurrency: 2 }
      )
    }
    // Then fetch ressources for all of them too
    for (const eleve of this.account.profile.eleves) {
      const eleveFolder = this.folders[eleve.id]
      await this.fetchEleveRessources(eleve, eleveFolder)
    }

    // Then digg in the past for homeworks week by week eleve by eleve
    const weeks = chunk(
      eachDay(this.getPreviousAugustLastDay(), subDays(new Date(), 1)).filter(
        day => !isSunday(day)
      ),
      6
    ).reverse()

    for (const [index, week] of weeks.entries()) {
      log('info', `Old homeworks week ${index}/${weeks.length}`)
      for (const eleve of this.account.profile.eleves) {
        const eleveFolder = this.folders[eleve.id]
        await this.fetchFutureHomeWorkDates(eleve)
        await bluebird.map(
          week,
          date =>
            this.fetchEleveHomeWorks(
              eleve,
              eleveFolder,
              format(date, 'YYYY-MM-DD')
            ),
          { concurrency: 2 }
        )
      }
    }
  }

  getPreviousAugustLastDay() {
    return subYears(lastDayOfMonth(setMonth(new Date(), 7)), 1)
  }

  async authenticate(identifiant, motdepasse) {
    try {
      let { accounts } = await this.request(`${baseUrl}/login.awp`, {
        identifiant,
        motdepasse
      })
      if (accounts.length > 1) {
        log('warn', `There are ${accounts.length}, taking the main one`)
      }
      this.account = accounts.find(account => account.main)
    } catch (err) {
      log('error', `Error code ${err}`)
      throw new Error(errors.LOGIN_FAILED)
    }
  }

  async initEtablissementFolder(fields) {
    const { nomEtablissement } = this.account
    fields.folderPath = `${fields.folderPath}/${nomEtablissement}`
    await mkdirp(fields.folderPath)
  }
  async initElevesFolders(fields) {
    this.folders = {}
    this.existingFolders = []
    for (const eleve of this.account.profile.eleves) {
      const eleveFolder = `${fields.folderPath}/${
        this.account.anneeScolaireCourante
      } - ${eleve.classe.libelle} (${eleve.prenom})`
      await mkdirp(eleveFolder)
      this.folders[eleve.id] = eleveFolder
    }
  }

  async fetchFutureHomeWorkDates(eleve) {
    const cahierTexte = await this.request(
      `${baseUrl}/Eleves/${eleve.id}/cahierdetexte.awp?verbe=get&`
    )
    return Object.keys(cahierTexte)
  }

  async fetchEleveHomeWorks(eleve, eleveFolder, date) {
    const devoirs = await this.request(
      `${baseUrl}/Eleves/${eleve.id}/cahierdetexte/${date}.awp?verbe=get&`
    )

    for (const matiere of devoirs.matieres) {
      if (matiere.aFaire) {
        const matiereFolder = `${eleveFolder}/${matiere.matiere}`
        if (!this.existingFolders.includes(matiereFolder)) {
          await mkdirp(matiereFolder)
          this.existingFolders.push(matiereFolder)
        }
        const readme = cheerio
          .load(Buffer.from(matiere.aFaire.contenu, 'base64').toString('utf8'))
          .text()
        await saveFiles(
          [
            {
              filestream: readme,
              filename: `${devoirs.date} Instructions.txt`
            }
          ],
          { folderPath: matiereFolder },
          {
            validateFile: () => true,
            shouldReplaceFile: () => true
          }
        )

        const documents = matiere.aFaire.ressourceDocuments.concat(
          matiere.aFaire.documents
        )
        const files = documents
          .filter(fichier => fichier.taille < 10000000)
          .map(fichier => {
            return {
              fileurl: `${baseUrl}/telechargement.awp?verbe=get`,
              filename: fichier.libelle,
              requestOptions: {
                method: 'POST',
                form: {
                  token: this.token,
                  leTypeDeFichier: fichier.type,
                  fichierId: fichier.id,
                  anneeMessages: ''
                }
              }
            }
          })
        if (files.length)
          await saveFiles(
            files,
            { folderPath: matiereFolder },
            {
              requestInstance: this.requestInstance,
              contentType: true,
              concurrency: 8
            }
          )
      }
    }
  }

  async fetchEleveRessources(eleve, eleveFolder) {
    const classId = eleve.classe.id
    const { matieres } = await this.request(
      `${baseUrl}/R/${classId}/viedelaclasse.awp?verbe=get&`
    )

    for (const matiere of matieres) {
      const matiereFolder = `${eleveFolder}/${matiere.libelle}`
      if (!this.existingFolders.includes(matiereFolder)) {
        await mkdirp(matiereFolder)
        this.existingFolders.push(matiereFolder)
      }

      const readme = cheerio
        .load(Buffer.from(matiere.contenu, 'base64').toString('utf8'))
        .text()
      await saveFiles(
        [{ filestream: readme, filename: 'Instructions.txt' }],
        { folderPath: matiereFolder },
        {
          validateFile: () => true,
          shouldReplaceFile: () => true
        }
      )
      const files = matiere.fichiers
        .filter(fichier => fichier.taille < 10000000)
        .map(fichier => {
          return {
            fileurl: `${baseUrl}/telechargement.awp?verbe=get`,
            filename: `${matiere.dateMiseAJour} ${fichier.libelle}`,
            requestOptions: {
              method: 'POST',
              form: {
                token: this.token,
                leTypeDeFichier: fichier.type,
                fichierId: fichier.id,
                anneeMessages: ''
              }
            }
          }
        })
      if (files.length)
        await saveFiles(
          files,
          { folderPath: matiereFolder },
          {
            requestInstance: this.requestInstance,
            contentType: true,
            concurrency: 8
          }
        )
    }
  }

  async request(url, formData = { token: this.token }) {
    const { token, data, code } = await this.requestInstance.post(url, {
      form: {
        data: JSON.stringify(formData)
      }
    })

    if (code !== 200) {
      throw new Error(code)
    }

    this.token = token
    return data
  }
}

const connector = new EcoleDirecteConnector()

connector.run()
